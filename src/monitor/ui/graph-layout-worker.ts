// This module runs in a real browser Worker. ELK installs its worker protocol on
// self.onmessage; the UI uses elk-api to register algorithms and request layout.
import 'elkjs/lib/elk-worker.min.js';
