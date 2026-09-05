/// <reference types="vite/client" />

// Vite ?raw import modifier
declare module '*?raw' {
  const content: string;
  export default content;
}
