// heic-decode no trae tipos: la API real (CJS) es decode({ buffer }) → { width, height,
// data } con data en RGBA (Uint8ClampedArray). Ver node_modules/heic-decode/lib.js.
declare module "heic-decode" {
  interface DecodedHeicImage {
    width: number
    height: number
    data: Uint8ClampedArray
  }
  interface HeicDecodeInput {
    buffer: Uint8Array | ArrayBuffer
  }
  function decode(input: HeicDecodeInput): Promise<DecodedHeicImage>
  export default decode
}
