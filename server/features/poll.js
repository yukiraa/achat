import { cleanText } from '../security.js';

// Chat polls.
// Start: from the dock, or a mod/owner types  !poll Question | Option A | Option B
// Vote:  !vote 2   (one vote per viewer across all platforms; voting again changes it)
// The overlay shows live bars in the Poll box, then highlights the winner.

const MAX_OPTIONS = 6;

export class PollFeature {
  constructor(getCfg, broadcast, log) {
    this.getCfg = getCfg;
    this.broadcast = broadcast;
    this.log = log;
    this.poll = null; // { question, options, votes: Map(userKey -> index), endsAt, ended }
  }

  view() {
    if (!this.poll) return { active: false };
    const p = this.poll;
    const counts = p.options.map(() => 0);
    for (const i of p.votes.values()) counts[i]++;
    const total = counts.reduce((a, b) => a + b, 0);
    let winner = -1;
    if (p.ended && total > 0) {
      const top = Math.max(...counts);
      const tied = counts.filter((c) => c === top).length;
      winner = tied === 1 ? counts.indexOf(top) : -2; // -2 means a tie
    }
    const cmds = this.getCfg().poll.commands.slice(0, p.options.length);
    return {
      commands: cmds,
      active: !p.ended,
      ended: p.ended,
      question: p.question,
      options: p.options,
      counts,
      total,
      endsAt: p.endsAt,
      duration: p.duration,
      winner,
    };
  }

  push() {
    this.broadcast({ type: 'poll', poll: this.view() });
  }

  start(question, options, seconds, by = 'dock') {
    const q = cleanText(question, 120);
    const opts = (options || []).map((o) => cleanText(o, 60)).filter(Boolean).slice(0, MAX_OPTIONS);
    if (!q) return { error: 'Write a question first' };
    if (opts.length < 2) return { error: 'Add at least two options' };
    const duration = Math.min(600, Math.max(10, Math.round(Number(seconds) || 60)));
    clearTimeout(this.endTimer);
    clearTimeout(this.hideTimer);
    clearInterval(this.pushTimer);
    this.poll = { question: q, options: opts, votes: new Map(), duration, endsAt: Date.now() + duration * 1000, ended: false };
    this.endTimer = setTimeout(() => this.end(), duration * 1000);
    // send updates at most a few times a second, even if votes pour in
    this.dirty = false;
    this.pushTimer = setInterval(() => {
      if (this.dirty) {
        this.dirty = false;
        this.push();
      }
    }, 300);
    this.log(`Poll started by ${by}: ${q} (${opts.length} options, ${duration}s)`);
    this.push();
    return { ok: true };
  }

  vote(user, raw) {
    const p = this.poll;
    if (!p || p.ended) return;
    const n = parseInt(String(raw).trim(), 10);
    if (!Number.isInteger(n) || n < 1 || n > p.options.length) return;
    if (p.votes.get(user.key) === n - 1) return;
    p.votes.set(user.key, n - 1);
    this.dirty = true;
  }

  end() {
    const p = this.poll;
    if (!p || p.ended) return;
    p.ended = true;
    clearTimeout(this.endTimer);
    clearInterval(this.pushTimer);
    const v = this.view();
    const result =
      v.total === 0 ? 'no votes' : v.winner === -2 ? 'a tie' : `"${p.options[v.winner]}" won`;
    this.log(`Poll ended: ${result} (${v.total} votes)`);
    this.push();
    const hold = this.getCfg().poll.resultSeconds;
    this.hideTimer = setTimeout(() => this.clear(), hold * 1000);
  }

  clear() {
    clearTimeout(this.endTimer);
    clearTimeout(this.hideTimer);
    clearInterval(this.pushTimer);
    this.poll = null;
    this.broadcast({ type: 'poll', poll: { active: false, cleared: true } });
  }

  // !poll Question | A | B   (mods and owner only)
  fromChat(user, text) {
    const parts = text.split('|').map((s) => s.trim());
    const res = this.start(parts[0], parts.slice(1), this.getCfg().poll.defaultSeconds, user.name);
    if (res.error) this.log(`Poll from ${user.name} not started: ${res.error}`);
  }
}
