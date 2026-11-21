// The Worker's entry: the server (./server.js) with the views connector/build.js generated into views.gen.js
// (wrangler.toml's [build] runs it before every deploy and `wrangler dev`).
import views from './views.gen.js';
import { createServer } from './server.js';

export default createServer(views);
