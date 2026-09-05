import './styles.css';
import { App } from './ui/app';

const app = new App();
app.init().catch(console.error);
