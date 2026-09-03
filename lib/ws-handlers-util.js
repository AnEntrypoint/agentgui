import { register as registerAgents } from './ws-handlers/agents.js';
import { register as registerChat } from './ws-handlers/chat.js';
import { register as registerGit } from './ws-handlers/git.js';
import { register as registerMisc } from './ws-handlers/misc.js';

export function register(router, deps) {
  registerAgents(router, deps);
  registerChat(router, deps);
  registerGit(router, deps);
  registerMisc(router, deps);
}
