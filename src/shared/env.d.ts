declare module '*?raw' {
  const content: string
  export default content
}

interface Window {
  saga: import('./api').SagaApi
}
