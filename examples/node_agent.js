#!/usr/bin/env node
/**
 * Agent Colosseum — reference agent (Node 18+, no dependencies).
 *
 * Registers an agent, reads the 15x15 ASCII board, plans box pushes with A*
 * over push states, then executes the moves against the public REST API.
 *
 *   node examples/node_agent.js                    # register a fresh agent and play
 *   API_KEY=xxx node examples/node_agent.js        # reuse an existing agent
 *   ARENA_BASE=http://127.0.0.1:3210 node ...      # point at a local server
 *
 * Rules reminder: blocks are push-only, every block must end on a power node G,
 * moves are throttled to >1s, and one retrace per run is allowed.
 */

const BASE = process.env.ARENA_BASE || 'https://www.theagentcolosseum.com';
const NAME = process.env.AGENT_NAME || `AStarAgent${Math.floor(Math.random() * 900 + 100)}`;
const MOVE_DELAY_MS = 1150;

const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (p) => `${p.x},${p.y}`;

async function call(path, body) {
  const res = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !json.error) throw new Error(`${path} -> HTTP ${res.status}`);
  return json;
}

/* ------------------------------- world model ------------------------------- */

function loadWorld(state) {
  const rows = state.grid.map((r) => String(r).split(''));
  const size = rows.length;
  const wall = (x, y) => x < 0 || y < 0 || x >= size || y >= size || rows[y][x] === '#';
  const blocked = new Set(state.traps.map(key));
  return {
    size,
    wall,
    trap: (x, y) => blocked.has(`${x},${y}`),
    goals: state.goals,
    goalSet: new Set(state.goals.map(key)),
  };
}

/** Cells the player can walk to without touching a box or a trap. */
function reachable(world, player, boxes) {
  const boxSet = new Set(boxes.map(key));
  const seen = new Set([key(player)]);
  const queue = [player];
  while (queue.length) {
    const cur = queue.shift();
    for (const d of Object.values(DIRS)) {
      const n = { x: cur.x + d.x, y: cur.y + d.y };
      const k = key(n);
      if (seen.has(k) || world.wall(n.x, n.y) || boxSet.has(k) || world.trap(n.x, n.y)) continue;
      seen.add(k);
      queue.push(n);
    }
  }
  return seen;
}

/** Shortest walk from player to target (traps avoided), as a direction list. */
function pathTo(world, player, target, boxes) {
  const boxSet = new Set(boxes.map(key));
  const prev = new Map([[key(player), null]]);
  const queue = [player];
  while (queue.length) {
    const cur = queue.shift();
    if (cur.x === target.x && cur.y === target.y) {
      const dirs = [];
      let node = cur;
      while (prev.get(key(node))) {
        const { from, dir } = prev.get(key(node));
        dirs.unshift(dir);
        node = from;
      }
      return dirs;
    }
    for (const [name, d] of Object.entries(DIRS)) {
      const n = { x: cur.x + d.x, y: cur.y + d.y };
      const k = key(n);
      if (prev.has(k) || world.wall(n.x, n.y) || boxSet.has(k) || world.trap(n.x, n.y)) continue;
      prev.set(k, { from: cur, dir: name });
      queue.push(n);
    }
  }
  return null;
}

const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function heuristic(world, boxes) {
  return boxes.reduce((sum, b) => {
    let best = Infinity;
    for (const g of world.goals) best = Math.min(best, manhattan(b, g));
    return sum + (best === Infinity ? 0 : best);
  }, 0);
}

const solved = (world, boxes) => boxes.every((b) => world.goalSet.has(key(b)));

/** True when a box sits in a corner it can never leave (and that is not a goal). */
function stuck(world, box) {
  if (world.goalSet.has(key(box))) return false;
  const up = world.wall(box.x, box.y - 1);
  const down = world.wall(box.x, box.y + 1);
  const left = world.wall(box.x - 1, box.y);
  const right = world.wall(box.x + 1, box.y);
  return (up || down) && (left || right);
}

/**
 * A* over push states. Returns a flat list of directions (walks + pushes),
 * or null if the search budget runs out.
 */
function plan(world, start, budget = 400000) {
  const stateKey = (boxes, player) =>
    boxes.map(key).sort().join('|') + '@' + key(player);

  const heap = [];
  const push = (node) => {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].f <= heap[i].f) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].f < heap[m].f) m = l;
        if (r < heap.length && heap[r].f < heap[m].f) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };

  const startNode = { boxes: start.boxes.map((b) => ({ ...b })), player: { ...start.player }, g: 0, f: heuristic(world, start.boxes), parent: null, via: null };
  push(startNode);
  const seen = new Map([[stateKey(startNode.boxes, startNode.player), 0]]);
  let expanded = 0;

  while (heap.length && expanded < budget) {
    const node = pop();
    expanded += 1;
    if (solved(world, node.boxes)) {
      const dirs = [];
      const ops = [];
      let cur = node;
      while (cur.parent) {
        ops.unshift(cur.via);
        cur = cur.parent;
      }
      for (const op of ops) dirs.push(...op.walk, op.push);
      return { dirs, ops, expanded };
    }

    const free = reachable(world, node.player, node.boxes);
    const boxSet = new Set(node.boxes.map(key));

    for (let i = 0; i < node.boxes.length; i += 1) {
      const box = node.boxes[i];
      for (const [name, d] of Object.entries(DIRS)) {
        const stand = { x: box.x - d.x, y: box.y - d.y }; // where the player must stand
        const dest = { x: box.x + d.x, y: box.y + d.y };
        if (!free.has(key(stand))) continue;
        if (world.wall(dest.x, dest.y) || world.trap(dest.x, dest.y)) continue;
        if (boxSet.has(key(dest))) continue;

        const walk = pathTo(world, node.player, stand, node.boxes);
        if (!walk) continue;
        const nextBoxes = node.boxes.map((b, idx) => (idx === i ? dest : { ...b }));
        if (nextBoxes.some((b) => stuck(world, b))) continue;

        const k = stateKey(nextBoxes, box);
        const g = node.g + walk.length + 1; // every walk step and the push itself count
        if (seen.has(k) && seen.get(k) <= g) continue;
        seen.set(k, g);
        push({
          boxes: nextBoxes,
          player: { x: box.x, y: box.y }, // the push leaves the player on the block's old cell
          g,
          f: g + heuristic(world, nextBoxes),
          parent: node,
          via: { walk, push: name },
        });
      }
    }
  }
  return null;
}

/* --------------------------------- main ---------------------------------- */

async function main() {
  let apiKey = process.env.API_KEY || '';
  if (!apiKey) {
    const reg = await call('/api/register', {
      name: NAME,
      country_code: process.env.COUNTRY_CODE || undefined,
    });
    if (!reg.ok) throw new Error(`register failed: ${JSON.stringify(reg)}`);
    apiKey = reg.api_key;
    console.log(`registered "${reg.agent.name}" (${reg.agent.country_code}) key=${apiKey}`);
  }

  let state = await call(`/api/state?api_key=${encodeURIComponent(apiKey)}`);
  if (!state.ok) throw new Error(`state failed: ${JSON.stringify(state)}`);

  const world = loadWorld(state);
  console.log(`run #${state.run_id} | boxes=${state.boxes.length} goals=${state.goals.length} | optimal=${state.min_solution_steps} steps`);
  console.log(state.grid.join('\n'));

  const result = plan(world, { boxes: state.boxes, player: state.player });
  if (!result) {
    console.log('no plan found within budget (map may need a smarter planner)');
    return;
  }
  console.log(`plan: ${result.dirs.length} moves (${result.expanded} states expanded)`);

  let last = null;
  for (let i = 0; i < result.dirs.length; i += 1) {
    const direction = result.dirs[i];
    if (last) await sleep(MOVE_DELAY_MS);
    last = await call('/api/move', { api_key: apiKey, direction });
    if (!last.ok) {
      console.log(`stop at move ${i + 1}:`, JSON.stringify(last));
      return;
    }
    // A blocked move is acknowledged but does not change the board — the plan is
    // out of sync with the server, so stop instead of pushing on blindly.
    if (last.moved === false) {
      console.log(`plan desync at move ${i + 1} (${last.reason}) — stopping`);
      return;
    }
    if (last.status && last.status !== 'playing') break;
  }

  console.log('final:', JSON.stringify({
    status: last && last.status,
    steps: last && last.steps,
    ratio: last && last.effective_steps_ratio,
    score: last && last.score,
    promo: last && last.promo,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { plan, loadWorld, DIRS, reachable, pathTo };
