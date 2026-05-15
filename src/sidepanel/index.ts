import './style.scss';

import { ChatView } from './chat-view';
import { SidepanelController } from './sidepanel-controller';

const app = document.getElementById('app');

if (!app) {
  throw new Error('Missing #app sidepanel root.');
}

const controller = new SidepanelController();
const view = new ChatView(app, controller.callbacks);

controller.bindView(view);
void controller.initialize();
