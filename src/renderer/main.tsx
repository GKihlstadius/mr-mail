import './lang';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Compose } from './Compose';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
root.render(location.hash === '#compose' ? <Compose /> : <App />);
