/// <reference types="vite/client" />
/// <reference path="../../preload/index.d.ts" />

declare module '*.svg' {
  const content: string
  export default content
}

declare module '*.png' {
  const content: string
  export default content
}
