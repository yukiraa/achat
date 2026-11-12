// Plays the animated arrival styles (Curve, Accordion, Liquid) inside the
// overlay's Chat box, using the normal template cards. Picked in the dock under
// Style > Animation > "How new messages arrive". overlay.js stays in charge of
// the connection and calls window.achatMotion.

import { Stage } from './engine.js';
import { PRESETS } from './presets/index.js';

const MODES = { curve: 'curve-it', accordion: 'accordion-it', liquid: 'liquid-chat' };

const chatLayer = document.getElementById('chatLayer');
const host = document.createElement('div');
host.id = 'motionHost';
chatLayer.append(host);
const stage = new Stage(host, PRESETS, { makeCard: (m) => window.achatTemplateCard(m) });
const showsChat = ['all', 'chat'].includes(document.body.dataset.layer);
let on = false;

// returns true when switching from classic chat to an animated style
function apply(s) {
  const preset = MODES[s.chat.animMode];
  if (!showsChat || !preset || s.chat.theme === 'custom') {
    if (on) stage.clear(true);
    on = false;
    return false;
  }
  stage.apply({
    preset,
    speed: 500 / (s.chat.animMs || 500), // the dock's Speed slider
    max: s.chat.maxMessages,
    life: s.chat.hideAfter || 0,
    side: s.chat.align === 'right' ? 'right' : 'left',
  });
  const was = on;
  on = true;
  return !was;
}

window.achatMotion = {
  active: () => on,
  apply,
  push: (m) => on && stage.push(m),
  remove: (id) => stage.remove(id),
  clear: (instant) => stage.clear(instant),
};
// settings that arrived before this module finished loading
for (const fn of window.__achatMotionWait || []) fn();
window.__achatMotionWait = [];
