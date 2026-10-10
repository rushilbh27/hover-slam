# Hoverslam

A rocket booster is falling toward a barge at sea at about 140 m/s. You have to land it upright, slowly, on the pad. The real engine can't throttle below 40%, so a nearly empty booster can't hover: the burn has to end right at the deck. That manoeuvre is called a hoverslam.

## Two modes

**Fly it (game).** You are the flight computer.

| Key | What it does |
| --- | --- |
| Space | Engine on or off |
| ← → | Lean the booster. On Easy and Medium it stops drifting by itself when you let go |
| ↑ | Slow down |
| ↓ | Speed up. Let go of both to hold your falling speed |
| R | Restart |

Phones get touch buttons. The "Expert" checkbox swaps in raw controls: the arrows swivel the engine directly and ↑/↓ move a throttle lever.

| Level | What changes |
| --- | --- |
| Easy | Light wind, wide pad, extra fuel, engine throttles to 15% so it can hover, a cue says when to light it, landing assist softens the last metres. Lands at up to 6 m/s |
| Medium | Real crosswind, no cue, lighter landing assist. Lands at up to 4.5 m/s |
| Hard | Strong gusts, small pad, 35% minimum throttle, no assist. Real limits: 3 m/s down, 1.5 m/s sideways, 6° tilt |

**Tune the autopilot (simulator).** The flight computer flies, using nine settings you choose. Press Run flight and watch. Afterwards it explains what went wrong using that flight's numbers (for example, "stopping needed 12.3 m/s² of braking; the engine could give 15.6") and offers buttons that nudge the setting to change. "Test all 5 winds" scores your settings on every wind.

| Setting | What it does |
| --- | --- |
| Ignition altitude | Height where the landing burn starts |
| Braking strength | How hard the speed plan brakes on the way down |
| Touchdown speed | Speed the plan aims for when the legs touch |
| Speed correction | How hard the throttle reacts when off the plan |
| Pad pull | How far it leans toward the pad per metre off centre |
| Drift brake | How far it leans against sideways drift |
| Max lean | Steepest lean allowed while steering |
| Attitude stiffness | How hard the engine swivels to reach the wanted lean |
| Attitude damping | How strongly it resists rotating (stops wobble) |

## How it works

2D rigid body at 120 steps a second. Engine gimbal ±7° at 20°/s, throttle with 0.25 s lag, fuel burn from Isp 282 s, drag that thins with altitude, seeded crosswind with gusts that fade near the surface, and small cold-gas thrusters for turning. The autopilot follows a braking speed plan v = −√(c² + 2ah) with feed-forward, leans toward the pad from its offset and drift, and holds attitude with a PD loop.

## Run it

```
npm start            # http://localhost:3000
npm run build        # dist/hoverslam.html, opens straight from disk
```

No dependencies.

Simplified physics for a game, with rough public figures for a booster. Not affiliated with SpaceX or any launch company.

MIT licence.
