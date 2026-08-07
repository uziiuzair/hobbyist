import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './theme.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('missing #root element')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
