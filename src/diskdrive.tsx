import React from "react";
import { SWITCHES, toHex, bank0 } from "./motherboard"
import { Buffer } from "buffer";
import disk2off from './img/disk2off.png'
import disk2on from './img/disk2on.png'
import disk2offEmpty from './img/disk2off-empty.png'
import disk2onEmpty from './img/disk2on-empty.png'
import driveMotor from './audio/driveMotor.mp3'
import driveTrackOffEnd from './audio/driveTrackOffEnd.mp3'
import driveTrackSeek from './audio/driveTrackSeekLong.mp3'
import { s6502 } from './instructions'

const emptyDisk = "(empty)"

export let dState = {
  fileName: emptyDisk,
  halftrack: 0,
  prevHalfTrack: 0,
  readMode: false,
  currentPhase: 0,
  diskImageHasChanges: false,
  motorIsRunning: false,
  trackStart: Array<number>(80),
  trackNbits: Array<number>(80),
  trackLocation: 0,
  isWriteProtected: false
}

let diskData = new Uint8Array()

export const getDriveState = () => {
  const data = Buffer.from(diskData).toString('base64')
  return { dState: dState, data: data }
}

export const setDriveState = (newState: any) => {
  dState = newState.dState
  diskData = Buffer.from(newState.data, 'base64')
}

const doDebugDrive = false

let motorContext: AudioContext | undefined
let motorElement: HTMLAudioElement | undefined
let trackSeekContext: AudioContext | undefined
let trackSeekElement: HTMLAudioElement | undefined
let trackOffEndContext: AudioContext | undefined
let trackOffEndElement: HTMLAudioElement | undefined
let trackTimeout = 0

export const doResetDrive = () => {
  SWITCHES.DRIVE.isSet = false
  doMotorTimeout()
  dState.halftrack = 0
}

export const doPauseDrive = (resume = false) => {
  if (resume) {
    if (dState.motorIsRunning) {
      startMotor()
    }
  } else {
    motorElement?.pause()
  }
}

const playTrackOutOfRange = () => {
  if (!trackOffEndContext) {
    trackOffEndContext = new AudioContext();
    trackOffEndElement = new Audio(driveTrackOffEnd);
    trackOffEndElement.volume = 0.5
    const node = trackOffEndContext.createMediaElementSource(trackOffEndElement);
    node.connect(trackOffEndContext.destination);
  }
  if (trackOffEndContext.state === 'suspended') {
    trackOffEndContext.resume();
  }
  if (!trackOffEndElement?.paused) {
    window.clearTimeout(trackTimeout)
    trackTimeout = window.setTimeout(() => trackOffEndElement?.pause(), 309);
    return
  }
  const playPromise = trackOffEndElement?.play();
  if (playPromise) {
    playPromise.then(function() {
      window.clearTimeout(trackTimeout)
      trackTimeout = window.setTimeout(() => trackOffEndElement?.pause(), 309);

    }).catch(function(error) {
      console.log(error)
    });
  }
}

const playTrackSeek = () => {
  if (!trackSeekContext) {
    trackSeekContext = new AudioContext();
    trackSeekElement = new Audio(driveTrackSeek);
    trackSeekElement.volume = 0.75
    const node = trackSeekContext.createMediaElementSource(trackSeekElement);
    node.connect(trackSeekContext.destination);
  }
  if (trackSeekContext.state === 'suspended') {
    trackSeekContext.resume();
  }
  if (!trackSeekElement?.paused) {
    window.clearTimeout(trackTimeout)
    trackTimeout = window.setTimeout(() => trackSeekElement?.pause(), 50);
    return
  }
  const playPromise = trackSeekElement?.play();
  if (playPromise) {
    playPromise.then(function() {
      window.clearTimeout(trackTimeout)
      trackTimeout = window.setTimeout(() => trackSeekElement?.pause(), 50);

    }).catch(function(error) {
      console.log(error)
    });
  }
}

const moveHead = (offset: number) => {
  if (dState.trackStart[dState.halftrack] > 0) {
    dState.prevHalfTrack = dState.halftrack
  }
  dState.halftrack += offset
  if (dState.halftrack < 0 || dState.halftrack > 68) {
    playTrackOutOfRange()
    dState.halftrack = (dState.halftrack < 0) ? 0 : (dState.halftrack > 68 ? 68 : dState.halftrack)
  } else {
    playTrackSeek()
  }
  // Adjust new track location based on arm position relative to old track loc.
  if (dState.trackStart[dState.halftrack] > 0 && dState.prevHalfTrack !== dState.halftrack) {
    // const oldloc = dState.trackLocation
    dState.trackLocation = Math.floor(dState.trackLocation * (dState.trackNbits[dState.halftrack] / dState.trackNbits[dState.prevHalfTrack]))
    if (dState.trackLocation > 3) {
      dState.trackLocation -= 4
    }
    // console.log(` track=${halftrack} ${oldloc} ${dState.trackLocation} ` +
    //   dState.trackNbits[halftrack] + " " + dState.trackNbits[dState.prevHalfTrack])
  }
}

const pickbit = [128, 64, 32, 16, 8, 4, 2, 1]
const clearbit = [0b01111111, 0b10111111, 0b11011111, 0b11101111,
  0b11110111, 0b11111011, 0b11111101, 0b11111110]

const getNextBit = () => {
  dState.trackLocation = dState.trackLocation % dState.trackNbits[dState.halftrack]
  let bit: number
  if (dState.trackStart[dState.halftrack] > 0) {
    const fileOffset = dState.trackStart[dState.halftrack] + (dState.trackLocation >> 3)
    const byte = diskData[fileOffset]
    const b = dState.trackLocation & 7
    bit = (byte & pickbit[b]) >> (7 - b)
  } else {
    // TODO: Freak out like a MC3470 and return random bits
    bit = 1
  }
  dState.trackLocation++
  return bit
}

const getNextByte = () => {
  if (diskData.length === 0) {
    return 0
  }
  let result = 0
  let bit = 0
  while (bit === 0) {
    bit = getNextBit()
  }
  result = 0x80   // the bit we just retrieved is the high bit
  for (let i = 6; i >= 0; i--) {
    result |= getNextBit() << i
  }
  // if (doDebugDrive) {
  //   console.log(" dState.trackLocation=" + dState.trackLocation +
  //     "  byte=" + toHex(result))
  // }
  return result
}

let writeByte = 0
let prevCycleCount = 0

const doWriteBit = (bit: 0 | 1) => {
  dState.trackLocation = dState.trackLocation % dState.trackNbits[dState.halftrack]
  // TODO: What about writing to empty tracks?
  if (dState.trackStart[dState.halftrack] > 0) {
    const fileOffset = dState.trackStart[dState.halftrack] + (dState.trackLocation >> 3)
    let byte = diskData[fileOffset]
    const b = dState.trackLocation & 7
    if (bit) {
      byte |= pickbit[b]
    } else {
      byte &= clearbit[b]
    }
    diskData[fileOffset] = byte
  }
  dState.trackLocation++
}

const doWriteByte = (cycleCount: number) => {
  // Sanity check to make sure we aren't on an empty track. Is this correct?
  if (diskData.length === 0 || dState.trackStart[dState.halftrack] === 0) {
    return
  }
  const delta = cycleCount - prevCycleCount
  if (delta >= 32 && writeByte > 0) {
    for (let i = 7; i >= 0; i--) {
      doWriteBit(writeByte & 2**i ? 1 : 0)      
    }
    if (delta >= 36) {
      doWriteBit(0)
    }
    if (delta >= 40) {
      doWriteBit(0)
    }
  }
  prevCycleCount = cycleCount
  writeByte = 0
  dState.diskImageHasChanges = true
}

export const handleDriveSoftSwitches =
  (addr: number, value: number, cycleCount: number): number => {
  let result = 0
  if (addr === SWITCHES.DRIVE.onAddr) {
    startMotor()
    return result
  } else if (addr === SWITCHES.DRIVE.offAddr) {
    stopMotor()
    return result
  }
  const phaseSwitches = [SWITCHES.DRVSM0, SWITCHES.DRVSM1,
    SWITCHES.DRVSM2, SWITCHES.DRVSM3]
  const a = addr - SWITCHES.DRVSM0.offAddr
  let debug = ""
  // One of the stepper motors has been turned on or off
  if (a >= 0 && a <= 7) {
    const ascend = phaseSwitches[(dState.currentPhase + 1) % 4]
    const descend = phaseSwitches[(dState.currentPhase + 3) % 4]
    if (!phaseSwitches[dState.currentPhase].isSet) {
      if (dState.motorIsRunning && ascend.isSet) {
        moveHead(1)
        dState.currentPhase = (dState.currentPhase + 1) % 4
        debug = "  currPhase=" + dState.currentPhase + " track=" + dState.halftrack / 2

      } else if (dState.motorIsRunning && descend.isSet) {
        moveHead(-1)
        dState.currentPhase = (dState.currentPhase + 3) % 4
        debug = "  currPhase=" + dState.currentPhase + " track=" + dState.halftrack / 2
      }
    }
    if (doDebugDrive) {
      console.log("***** PC=" + toHex(s6502.PC,4) + "  addr=" + toHex(addr,4) +
        " phase=" + (a >> 1) + (a % 2 === 0 ? " off" : " on ") +
        " 0x27=" + toHex(bank0[0x27]) + debug)
    }
  } else if (addr === SWITCHES.DRVWRITE.offAddr) {
    dState.readMode = true
    if (SWITCHES.DRVDATA.isSet) {
      result = dState.isWriteProtected ? 0xFF : 0
    }
  } else if (addr === SWITCHES.DRVWRITE.onAddr) {
    dState.readMode = false
    if (value >= 0) {
      writeByte = value
    }
  } else if (addr === SWITCHES.DRVDATA.offAddr) {
    if (dState.motorIsRunning) {
      if (dState.readMode) {
        result = getNextByte()
      } else {
        doWriteByte(cycleCount)
      }
    }
  } else if (addr === SWITCHES.DRVDATA.onAddr) {
    if (value >= 0) {
      writeByte = value
    }
  }
//  if (result === 0) {
//    console.log("addr=" + toHex(addr,4) + " writeByte=" +
//      toHex(writeByte) + " cycles: " + delta)
//  }
  return result
}

let crcTable = new Uint32Array(256).fill(0)

const makeCRCTable = () => {
  let c;
  for (let n =0; n < 256; n++) {
    c = n;
    for (let k =0; k < 8; k++) {
      c = ((c&1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    }
    crcTable[n] = c;
  }
}

const crc32 = (data: Uint8Array, offset = 0) => {
  if (crcTable[255] === 0) {
    makeCRCTable()
  }
  let crc = 0 ^ (-1);
  for (let i = offset; i < data.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ data[i]) & 0xFF];
  }

  return (crc ^ (-1)) >>> 0;
};

const decodeDiskData = (fileName: string) => {
  const woz2 = [0x57, 0x4F, 0x5A, 0x32, 0xFF, 0x0A, 0x0D, 0x0A]
  const isWoz2 = woz2.find((value, i) => value !== diskData[i]) === undefined
  dState.diskImageHasChanges = false
  if (isWoz2) {
    dState.isWriteProtected = diskData[22] === 1
    const crc = diskData.slice(8, 12)
    const storedCRC = crc[0] + (crc[1] << 8) + (crc[2] << 16) + crc[3] * (2 ** 24)
    const actualCRC = crc32(diskData, 12)
    if (storedCRC !== 0 && storedCRC !== actualCRC) {
      console.error("CRC checksum error: " + fileName)
    }
    for (let htrack=0; htrack < 80; htrack++) {
      const tmap_index = diskData[88 + htrack * 2]
      if (tmap_index < 255) {
        const tmap_offset = 256 + 8 * tmap_index
        const trk = diskData.slice(tmap_offset, tmap_offset + 8)
        dState.trackStart[htrack] = 512*(trk[0] + (trk[1] << 8))
        // const nBlocks = trk[2] + (trk[3] << 8)
        dState.trackNbits[htrack] = trk[4] + (trk[5] << 8) + (trk[6] << 16) + trk[7] * (2 ** 24)
      } else {
        dState.trackStart[htrack] = 0
        dState.trackNbits[htrack] = 51200
        console.log(`empty woz2 track ${htrack / 2}`)
      }
    }
    return
  }
  const woz1 = [0x57, 0x4F, 0x5A, 0x31, 0xFF, 0x0A, 0x0D, 0x0A]
  const isWoz1 = woz1.find((value, i) => value !== diskData[i]) === undefined
  if (isWoz1) {
    dState.isWriteProtected = diskData[22] === 1
    for (let htrack=0; htrack < 80; htrack++) {
      const tmap_index = diskData[88 + htrack * 2]
      if (tmap_index < 255) {
        dState.trackStart[htrack] = 256 + tmap_index * 6656
        const trk = diskData.slice(dState.trackStart[htrack] + 6646, dState.trackStart[htrack] + 6656)
        dState.trackNbits[htrack] = trk[2] + (trk[3] << 8)
      } else {
        dState.trackStart[htrack] = 0
        dState.trackNbits[htrack] = 51200
        console.log(`empty woz1 track ${htrack / 2}`)
      }
    }
    return
  }
  console.error("Unknown disk format.")
  diskData = new Uint8Array()
}

const doMotorTimeout = () => {
  if (!SWITCHES.DRIVE.isSet) {
    dState.motorIsRunning = false
    motorElement?.pause()
  }
}

const startMotor = () => {
  dState.motorIsRunning = true
  if (!motorContext) {
    motorContext = new AudioContext();
    motorElement = new Audio(driveMotor);
    motorElement.loop = true
    motorElement.volume = 0.5
    document.body.appendChild(motorElement);
    const node = motorContext.createMediaElementSource(motorElement);
    node.connect(motorContext.destination);
  }
  if (!motorElement) {
    return
  }
  if (motorContext.state === 'suspended') {
    motorContext.resume();
  }
  if (!motorElement.paused) {
    return
  }
  motorElement.play();
}

const stopMotor = () => {
  window.setTimeout(() => doMotorTimeout(), 1000);
}

class DiskDrive extends React.Component<{}, {fileName: string}> {

  // Hidden file input element
  hiddenFileInput: HTMLInputElement | null = null;
  // https://medium.com/@650egor/simple-drag-and-drop-file-upload-in-react-2cb409d88929
  handleDrop = (e: any) => {this.dropHandler(e as DragEvent)}
  handleDrag = (e: DragEvent) => 
    {e.preventDefault(); e.stopPropagation()}

  constructor(props: any) {
    super(props);
    this.state = { fileName: emptyDisk };
  }

  componentDidMount() {
    window.addEventListener('drop', this.handleDrop)
    window.addEventListener('dragover', this.handleDrag)
  }

  componentWillUnmount() {
    window.removeEventListener('drop', this.handleDrop)
    window.removeEventListener('dragover', this.handleDrag)
  }

  readDisk = async (file: File) => {
    const buffer = await file.arrayBuffer();
    diskData = new Uint8Array(buffer);
    decodeDiskData(file.name)
    dState.fileName = (diskData.length > 0) ? file.name : emptyDisk
    this.forceUpdate()
  }

  handleDiskClick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target?.files?.length) {
      this.readDisk(e.target.files[0])
    }
  };

  downloadDisk = () => {
    const crc = crc32(diskData, 12)
    diskData[8] = crc & 0xFF
    diskData[9] = (crc >>> 8) & 0xFF
    diskData[10] = (crc >>> 16) & 0xFF
    diskData[11] = (crc >>> 24) & 0xFF
    const blob = new Blob([diskData]);
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', dState.fileName);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  dropHandler = (e: DragEvent) => {    
    e.preventDefault()
    e.stopPropagation()
    const f = e.dataTransfer?.files
    if (f && f.length > 0) {
      this.readDisk(f[0])
    }
  }

  render() {
    const img = (diskData.length > 0) ?
      (dState.motorIsRunning ? disk2on : disk2off) :
      (dState.motorIsRunning ? disk2onEmpty : disk2offEmpty)
    return (
      <span>
        <span className="fixed">{dState.halftrack / 2}</span>
        <img className="disk2" src={img} alt={dState.fileName}
          title={dState.fileName}
          onClick={() => {
            if (diskData.length > 0) {
              if (dState.diskImageHasChanges) {
                this.downloadDisk()
              }
              diskData = new Uint8Array()
              dState.fileName = emptyDisk
              this.forceUpdate()
            } else {
              if (this.hiddenFileInput) {
                // Hack - clear out old file so we can pick the same file again
                this.hiddenFileInput.value = "";
                this.hiddenFileInput.click()
              }
            }
          }} />
        <input
          type="file"
          ref={input => this.hiddenFileInput = input}
          onChange={this.handleDiskClick}
          style={{display: 'none'}}
        />
      </span>
    );
  }
}

export default DiskDrive;
