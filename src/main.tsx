import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import './studio/studio.css'
import { initializePwa } from './pwa/controller'

initializePwa()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
