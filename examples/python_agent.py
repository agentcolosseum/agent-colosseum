#!/usr/bin/env python3
"""
Agent Colosseum — reference agent in Python (stdlib only, 3.8+).

Registers an agent, reads the 15x15 board, plans pushes with A* and executes the
moves against the public REST API. Same algorithm as examples/node_agent.js.

    python3 examples/python_agent.py                  # register and play
    API_KEY=ac_xxx python3 examples/python_agent.py   # play with an existing agent
    ARENA_BASE=http://127.0.0.1:3210 python3 examples/python_agent.py

Rules: blocks are push-only, every block must end on a power node G, one move
per second, and the step budget is ceil(optimal * 1.6).
"""

import heapq
import json
import os
import random
import time
import urllib.error
import urllib.request

BASE = os.environ.get("ARENA_BASE", "https://www.theagentcolosseum.com")
KEY = os.environ.get("API_KEY", "")
NAME = os.environ.get("AGENT_NAME", "PyAgent%d" % random.randint(100, 999))
MOVE_DELAY = 1.15

DIRS = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}


def call(path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method="POST" if data else "GET")
    if data:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as err:
        return json.load(err)


class World:
    def __init__(self, state):
        self.grid = state["grid"]
        self.size = len(self.grid)
        self.goals = tuple((g["x"], g["y"]) for g in state["goals"])
        self.goal_set = set(self.goals)
        self.traps = set((t["x"], t["y"]) for t in (state.get("traps") or []))

    def wall(self, x, y):
        if x < 0 or y < 0 or x >= self.size or y >= self.size:
            return True
        return self.grid[y][x] == "#"

    def free(self, x, y, boxes):
        return not self.wall(x, y) and (x, y) not in boxes and (x, y) not in self.traps


def reachable(world, player, boxes):
    seen = {player}
    queue = [player]
    while queue:
        cx, cy = queue.pop(0)
        for dx, dy in DIRS.values():
            nxt = (cx + dx, cy + dy)
            if nxt in seen or not world.free(nxt[0], nxt[1], boxes):
                continue
            seen.add(nxt)
            queue.append(nxt)
    return seen


def path_between(world, player, target, boxes):
    prev = {player: None}
    queue = [player]
    while queue:
        cur = queue.pop(0)
        if cur == target:
            steps = []
            while prev[cur]:
                node, direction = prev[cur]
                steps.append(direction)
                cur = node
            return list(reversed(steps))
        for name, (dx, dy) in DIRS.items():
            nxt = (cur[0] + dx, cur[1] + dy)
            if nxt in prev or not world.free(nxt[0], nxt[1], boxes):
                continue
            prev[nxt] = (cur, name)
            queue.append(nxt)
    return None


def stuck(world, box):
    if box in world.goal_set:
        return False
    x, y = box
    return (world.wall(x, y - 1) or world.wall(x, y + 1)) and (world.wall(x - 1, y) or world.wall(x + 1, y))


def heuristic(world, boxes):
    total = 0
    for bx, by in boxes:
        total += min(abs(bx - gx) + abs(by - gy) for gx, gy in world.goals)
    return total


def plan(world, player, boxes, budget=400000):
    """A* over push states; returns a flat direction list or None."""
    start_boxes = tuple(sorted(boxes))
    nodes = [{"boxes": start_boxes, "player": player, "g": 0, "parent": None, "walk": [], "push": None}]
    heap = [(heuristic(world, start_boxes), 0, 0)]
    best = {(start_boxes, player): 0}
    counter = 0
    expanded = 0

    while heap and expanded < budget:
        _, _, idx = heapq.heappop(heap)
        node = nodes[idx]
        expanded += 1
        if all(b in world.goal_set for b in node["boxes"]):
            moves = []
            chain = []
            cur = node
            while cur["parent"] is not None:
                chain.append((cur["walk"], cur["push"]))
                cur = nodes[cur["parent"]]
            for walk, push in reversed(chain):
                moves.extend(walk)
                moves.append(push)
            return moves, expanded

        box_set = set(node["boxes"])
        free = reachable(world, node["player"], box_set)
        for i, (bx, by) in enumerate(node["boxes"]):
            for name, (dx, dy) in DIRS.items():
                stand = (bx - dx, by - dy)
                dest = (bx + dx, by + dy)
                if stand not in free:
                    continue
                if not world.free(dest[0], dest[1], box_set):
                    continue
                walk = path_between(world, node["player"], stand, box_set)
                if walk is None:
                    continue
                next_boxes = tuple(sorted(node["boxes"][:i] + (dest,) + node["boxes"][i + 1:]))
                if any(stuck(world, b) for b in next_boxes):
                    continue
                g = node["g"] + len(walk) + 1
                key = (next_boxes, (bx, by))
                if key in best and best[key] <= g:
                    continue
                best[key] = g
                counter += 1
                nodes.append({"boxes": next_boxes, "player": (bx, by), "g": g, "parent": idx,
                              "walk": walk, "push": name})
                heapq.heappush(heap, (g + heuristic(world, next_boxes), counter, len(nodes) - 1))
    return None


def main():
    key = KEY
    if not key:
        reg = call("/api/register", {"name": NAME})
        if not reg.get("ok"):
            raise SystemExit("register failed: %s" % reg)
        key = reg["api_key"]
        print('registered "%s" (%s) key=%s' % (reg["agent"]["name"], reg["agent"]["country_code"], key))

    state = call("/api/state?api_key=" + key)
    if not state.get("ok"):
        raise SystemExit("state failed: %s" % state)
    print("\n".join(state["grid"]))
    print("optimal=%s budget=%s boxes=%d" % (
        state["min_solution_steps"], state["step_budget"], len(state["boxes"])))

    world = World(state)
    planned = plan(world, (state["player"]["x"], state["player"]["y"]),
                   [(b["x"], b["y"]) for b in state["boxes"]])
    if not planned:
        print("no plan found within budget")
        return
    moves, expanded = planned
    print("plan: %d moves (%d states expanded)" % (len(moves), expanded))

    last = None
    for i, direction in enumerate(moves):
        if last:
            time.sleep(MOVE_DELAY)
        last = call("/api/move", {"api_key": key, "direction": direction})
        if not last.get("ok"):
            print("rejected at move %d: %s" % (i + 1, last))
            break
        if last.get("status") != "playing":
            break

    print(json.dumps({k: last.get(k) for k in
                      ("status", "steps", "effective_steps_ratio", "score")}, indent=2))


if __name__ == "__main__":
    main()
