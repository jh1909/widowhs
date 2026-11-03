"""Prototype replay of the proposed skill rating (docs/briefs/01-skill-rating.md).

Replays every stored round in order with pairwise kill share, the winner's
bonus, the 30 s cutoff and Glicko-style uncertainty, then compares the result
with the current formula ELO. Settings are untuned; this is a reference for
the real backtest, not the implementation.

Input is the COPY data of player_matches and players from a production
backup, for example:

  python3 scripts/sr-prototype.py \
    <(pg_restore --data-only -t player_matches -f - public.dump) \
    <(pg_restore --data-only -t players -f - public.dump) \
    MODE [M BETA] [NAMES...]

Options: --clip=C caps each pair's surprise; --skim=K drops sessions under K
kills per minute.

MODE: sweep (prediction accuracy across settings), rank M BETA (leaderboard
comparison), show M BETA NAME... (individual players) or trace M BETA
NAME... (round-by-round SR). Add --twopass to start each player from their
first-pass rating instead of 1500, removing the cold start. M scales how much one
round can move a rating (higher reacts faster); BETA is the winner's bonus.
"""
import sys, math, collections, datetime as dt

def _flag(name):
    for a in list(sys.argv):
        if a.startswith(name + '='):
            sys.argv.remove(a); return float(a.split('=', 1)[1])
    return None
CLIP = _flag('--clip')  # cap each pair's surprise (S - E) at +/- this value
SKIM = _flag('--skim')  # drop sessions below this many kills per minute

def copy_rows(path):
    rows, cols, on = [], None, False
    for line in open(path, encoding='utf-8'):
        if line.startswith('COPY '):
            cols = line[line.index('(')+1:line.index(')')].split(', '); on = True; continue
        if on:
            if line.startswith('\\.'): break
            vals = line.rstrip('\n').split('\t')
            vals = [None if v == '\\N' else v.replace('\\t','\t').replace('\\n','\n').replace('\\\\','\\') for v in vals]
            rows.append(dict(zip(cols, vals)))
    return rows

def ts(s):
    s = s.replace(' ', 'T')
    if s[-3] in '+-' and s[-6] != ':': s += ':00'
    return dt.datetime.fromisoformat(s)

pm = copy_rows(sys.argv[1]); players = copy_rows(sys.argv[2])
rounds = collections.defaultdict(list)
for r in pm:
    rounds[r['match_id']].append(r)
order = sorted(rounds, key=lambda m: min((ts(r['played_at']), ts(r['created_at'])) for r in rounds[m]))

GRACE = 10  # days without play before uncertainty starts to grow (brief 02)
TRACE = {}  # name -> per-round rows, filled when mode is trace
Q = math.log(10) / 400
def g(rd): return 1 / math.sqrt(1 + 3 * Q*Q * rd*rd / math.pi**2)

def run(M, beta, C=10.0, RD0=350.0, RDMIN=50.0, collect=False, seed=None, seed_rd=150.0):
    R, RD, last, full = {}, {}, {}, collections.Counter()
    hits = tot = bhits = 0
    hist = collections.defaultdict(list)
    for m in order:
        rows = rounds[m]
        when = min(ts(r['played_at']) for r in rows)
        parts = []
        for r in rows:
            t = float(r['time_in_lobby'] or 0); k = float(r['score'] or 0)
            parts.append([r['player_name'], k, t])
        L = None
        tm = [r['total_match_time'] for r in rows if r['total_match_time']]
        L = max(float(x) for x in tm) if tm else max(p[2] for p in parts)
        if not L or L <= 0: continue
        parts = [p for p in parts if p[2] >= 30 and not (SKIM is not None and p[1] / (p[2] / 60) < SKIM)]
        # merge duplicate names within a round (current importer behaviour)
        agg = {}
        for n, k, t in parts:
            if n in agg: agg[n][0] += k; agg[n][1] = max(agg[n][1], t)
            else: agg[n] = [k, t]
        names = list(agg)
        if len(names) < 2: continue
        top = max(names, key=lambda n: agg[n][0])
        winner = top if agg[top][0] >= 50 else None
        for n in names:
            if n not in R: R[n], RD[n] = (seed[n], seed_rd) if seed and n in seed else (1500.0, RD0)
            elif n in last:
                days = (when - last[n]).total_seconds() / 86400
                RD[n] = min(RD0, math.sqrt(RD[n]**2 + C*C*max(days - GRACE, 0)))
        pre = {n: (R[n], RD[n]) for n in names}
        scale = M / (len(names) - 1)
        acc = {n: [0.0, 0.0] for n in names}   # sum w g (S-E), sum w g^2 E(1-E)
        for a in range(len(names)):
            for b in range(a+1, len(names)):
                i, j = names[a], names[b]
                ki, ti = agg[i]; kj, tj = agg[j]
                if ti > tj: ki = ki * tj / ti
                elif tj > ti: kj = kj * ti / tj
                if ki + kj <= 0: continue
                S = ki / (ki + kj)
                if winner == i: S = S + beta * (1 - S)
                elif winner == j: S = 1 - ((1 - S) + beta * S)
                w = min(1, ti / L, tj / L) * scale
                ri, rdi = pre[i]; rj, rdj = pre[j]
                hi, hj = hist[i][-100:], hist[j][-100:]
                if collect and full[i] >= 5 and full[j] >= 5 and len(hi) >= 5 and len(hj) >= 5 and agg[i][0] != agg[j][0]:
                    tot += 1; up = agg[i][0] > agg[j][0]
                    hits += ((ri > rj) == up)
                    bhits += ((sum(hi)/len(hi) > sum(hj)/len(hj)) == up)
                for x, y, s, rx, ry, rdy in ((i, j, S, ri, rj, rdj), (j, i, 1 - S, rj, ri, rdi)):
                    gg = g(rdy); E = 1 / (1 + 10 ** (-gg * (rx - ry) / 400))
                    d = s - E
                    if CLIP is not None: d = max(-CLIP, min(CLIP, d))
                    acc[x][0] += w * gg * d; acc[x][1] += w * gg*gg * E * (1 - E)
        for n in names:
            r, rd = pre[n]; s1, s2 = acc[n]
            if s2 <= 0: continue
            d2 = 1 / (Q*Q * s2)
            inv = 1 / (rd*rd) + 1 / d2
            R[n] = r + Q / inv * s1
            if collect and n in TRACE:
                opp = [pre[y][0] for y in names if y != n]
                TRACE[n].append((when, agg[n][0], agg[n][1], L, sorted((agg[y][0] for y in names), reverse=True)[:3],
                                 len(names), sum(opp) / len(opp), r, R[n], winner == n))
            RD[n] = max(RDMIN, math.sqrt(1 / inv))
            last[n] = when
            if agg[n][1] / L >= 0.999 or agg[n][1] >= L - 10: full[n] += 1
        for r in rows:
            if r['performance_score'] is not None: hist[r['player_name']].append(float(r['performance_score']))
    run.base = bhits / tot if tot else 0
    return R, RD, last, full, (hits / tot if tot else 0), tot, when

if sys.argv[3] == 'sweep':
    for M in (3, 5, 8, 12, 20):
        for beta in (0.0, 0.1):
            *_, a, n, _w = run(M, beta, collect=True)
            print(f"M={M} beta={beta}: SR {a:.4f} vs current formula {run.base:.4f} on the same {n} pairs")
    sys.exit()
    # baseline: mean of previous per-round performance_score (approximation of current formula)
    hist = collections.defaultdict(list); hits = tot = 0
    for m in order:
        rows = [r for r in rounds[m] if float(r['time_in_lobby'] or 0) >= 30]
        sc = {}
        for r in rows:
            h = hist[r['player_name']]
            sc[r['player_name']] = (sum(h[-100:]) / len(h[-100:])) if len(h) >= 5 else None
        for a in range(len(rows)):
            for b in range(a+1, len(rows)):
                i, j = rows[a], rows[b]
                si, sj = sc[i['player_name']], sc[j['player_name']]
                ki, kj = float(i['score'] or 0), float(j['score'] or 0)
                if si is None or sj is None or ki == kj or i['player_name'] == j['player_name']: continue
                tot += 1; hits += ((si > sj) == (ki > kj))
        for r in rounds[m]:
            if r['performance_score'] is not None: hist[r['player_name']].append(float(r['performance_score']))
    print(f"baseline (recent avg per-round formula score): {hits/tot:.4f} over {tot} pairs")
    sys.exit()

M, beta = float(sys.argv[4]), float(sys.argv[5])
TWOPASS = '--twopass' in sys.argv
if TWOPASS: sys.argv.remove('--twopass')
if sys.argv[3] == 'trace':
    for x in sys.argv[6:]: TRACE[x] = []
    run(M, beta, collect=True)
    for x, rows in TRACE.items():
        print(f"== {x}: date | kills | time/round | top 3 kills | players | lobby SR | SR before -> after")
        for w, k, t, L, top, n, lob, b0, b1, won in rows:
            print(f"{w:%m-%d %H:%M} | {k:>3.0f}{' W' if won else '  '} | {t:>4.0f}/{L:<4.0f} | {top} | {n:>2} | {lob:.0f} | {b0:.0f} -> {b1:.0f} ({b1-b0:+.0f})")
    sys.exit()
R, RD, last, full, a, n, end = run(M, beta, collect=True)
if TWOPASS:
    R, RD, last, full, a, n, end = run(M, beta, collect=True, seed=dict(R))
C = 10.0
for nme in R:
    days = (end - last.get(nme, end)).total_seconds() / 86400
    RD[nme] = min(350.0, math.sqrt(RD[nme]**2 + C*C*max(days - GRACE, 0)))
info = {p['name']: p for p in players}
def eligible(x):
    p = info.get(x)
    return p is not None and p['is_banned'] != 't' and int(p['placement_matches'] or 0) >= 10
def num(v):
    try: return float(v)
    except (TypeError, ValueError): return None
oldl = sorted([p['name'] for p in players if eligible(p['name']) and num(p['elo']) is not None], key=lambda x: (-num(info[x]['elo']), x))
old = {x: i+1 for i, x in enumerate(oldl)}
newl = sorted([x for x in R if eligible(x)], key=lambda x: -(R[x] - 2*RD[x]))
inactive = [x for x in newl if RD[x] > 110]
newl = [x for x in newl if RD[x] <= 110]
new = {x: i+1 for i, x in enumerate(newl)}
if sys.argv[3] == 'show':
    raw = {x: i+1 for i, x in enumerate(sorted(new, key=lambda x: -R[x]))}
    for x in sys.argv[6:]:
        if x not in R: print(f"{x}: no rated rounds"); continue
        p = info.get(x, {})
        opp, share = [], []
        for m, rows in rounds.items():
            names = [r['player_name'] for r in rows if float(r['time_in_lobby'] or 0) >= 30]
            if x in names and len(names) > 1:
                opp.append(sum(R.get(y, 1500) for y in names if y != x) / (len(names) - 1))
                kills = {r['player_name']: float(r['score'] or 0) for r in rows}
                share.append(kills[x] / (max(kills.values()) or 1))
        print(f"{x}: current rank {old.get(x, 'unplaced')} (elo {p.get('elo')}, placements {p.get('placement_matches')}) | "
              f"SR rank {new.get(x, 'unplaced')} (by SR alone {raw.get(x, '-')}) | SR {R[x]:.0f} ±{2*RD[x]:.0f} | "
              f"mean opponent SR {sum(opp)/len(opp):.0f} | kills {100*sum(share)/len(share):.0f}% of round leader | "
              f"K/D {p.get('recent_kdr')} acc {p.get('recent_accuracy')} kpm {p.get('recent_kpm')} | last {last[x]:%Y-%m-%d}")
    sys.exit()
print(f"data ends {end:%Y-%m-%d}; rounds {len(order)}; SR order accuracy {a:.4f}")
print(f"current leaderboard {len(old)} players; SR leaderboard {len(new)} (+{len(inactive)} eligible but range too wide after inactivity)")
print("\nTOP 25 SR | cautious | SR ± | current rank | placements | last played")
for x in newl[:25]:
    print(f"{new[x]:>3} {x} | {R[x]-2*RD[x]:.0f} | {R[x]:.0f} ±{2*RD[x]:.0f} | {old.get(x,'-')} (elo {info[x]['elo']}) | {info[x]['placement_matches']} | {last[x]:%Y-%m-%d}")
both = [x for x in new if x in old]
ro = {x: i+1 for i, x in enumerate(sorted(both, key=lambda x: old[x]))}
rn = {x: i+1 for i, x in enumerate(sorted(both, key=lambda x: new[x]))}
n = len(both)
print(f"\nSpearman on {n} players in both:", round(1 - 6*sum((ro[x]-rn[x])**2 for x in both)/(n*(n*n-1)), 3))
mv = sorted(both, key=lambda x: ro[x]-rn[x])
print("\nBIGGEST UP (current -> SR, within shared players)")
for x in reversed(mv[-12:]): print(f"  {x}: {ro[x]} -> {rn[x]} (+{ro[x]-rn[x]}) elo {info[x]['elo']} placements {info[x]['placement_matches']}")
print("\nBIGGEST DOWN")
for x in mv[:12]: print(f"  {x}: {ro[x]} -> {rn[x]} ({ro[x]-rn[x]}) elo {info[x]['elo']} placements {info[x]['placement_matches']}")
print("\nCURRENT TOP 25 and their SR rank")
for x in oldl[:25]: print(f"  {old[x]:>3} {x}: SR rank {new.get(x, 'unplaced (inactive)' if x in inactive else 'not rated')} elo {info[x]['elo']}")
