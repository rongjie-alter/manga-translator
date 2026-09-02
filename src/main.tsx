import { render } from 'preact'
import { App } from './app'
import './ui/styles.css'

const root = document.getElementById('app')
if (!root) throw new Error('no #app element to mount into')
render(<App />, root)
