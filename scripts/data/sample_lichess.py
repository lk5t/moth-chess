#!/usr/bin/env python3
"""Samples the Lichess open database (CC0, https://database.lichess.org) into small training files.

games:   rated standard games with both players >= MIN_ELO, decisive or drawn by normal play,
         >= 20 plies, no time forfeit / abandonment  -> lichess-games.pgn.gz
puzzles: up to PER_THEME puzzles for each tactical theme MOTH is tested on -> lichess-puzzles.csv.gz
"""
import csv, gzip, io, random, re, sys

random.seed(20261104)
mode, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]

if mode == 'games':
    MIN_ELO, LIMIT = 1800, int(sys.argv[4]) if len(sys.argv) > 4 else 24000
    kept = 0
    out = gzip.open(dst, 'wt', encoding='utf-8')
    game = []
    def flush(lines):
        global kept
        if not lines: return
        text = ''.join(lines)
        h = dict(re.findall(r'^\[(\w+) "([^"]*)"\]', text, re.M))
        try:
            we, be = int(h.get('WhiteElo', '0')), int(h.get('BlackElo', '0'))
        except ValueError:
            return
        if we < MIN_ELO or be < MIN_ELO: return
        if h.get('Termination') != 'Normal' or h.get('Result') not in ('1-0', '0-1', '1/2-1/2'): return
        if 'Bullet' in h.get('Event', '') : return
        moves = text.split('\n\n', 1)[1] if '\n\n' in text else ''
        if len(re.findall(r'\d+\.', moves)) < 10: return
        out.write(text.strip() + '\n\n'); kept += 1
    with open(src, encoding='utf-8', errors='replace') as f:
        for line in f:
            if line.startswith('[Event ') and game:
                flush(game); game = []
                if kept >= LIMIT: break
            game.append(line)
        if kept < LIMIT: flush(game)
    out.close()
    print('games kept', kept)

elif mode == 'puzzles':
    THEMES = ['mateIn1', 'mateIn2', 'mateIn3', 'mateIn4', 'sacrifice', 'queenSacrifice'.lower(), 'fork', 'pin', 'skewer',
              'discoveredAttack', 'doubleCheck', 'defensiveMove', 'exposedKing', 'kingsideAttack', 'attraction', 'deflection',
              'quietMove', 'hangingPiece', 'trappedPiece', 'xRayAttack', 'zugzwang', 'endgame', 'middlegame', 'opening',
              'crushing', 'advantage', 'equality', 'smotheredMate', 'backRankMate', 'anastasiaMate', 'arabianMate',
              'hookMate', 'promotion', 'underPromotion', 'enPassant', 'castling', 'capturingDefender', 'intermezzo', 'clearance']
    PER_THEME = int(sys.argv[4]) if len(sys.argv) > 4 else 250
    buckets = {t: [] for t in THEMES}
    seen = {}
    with open(src, encoding='utf-8') as f:
        r = csv.reader(f)
        header = next(r)
        for i, row in enumerate(r):
            rid, fen, moves, rating, dev, pop, plays, themes = row[:8]
            if int(plays) < 200 or int(pop) < 80: continue
            ts = themes.split()
            low = [t.lower() for t in ts]
            for t in THEMES:
                if t.lower() in low:
                    b = buckets[t]
                    # reservoir sampling per theme
                    if len(b) < PER_THEME: b.append(row[:8])
                    else:
                        j = random.randint(0, i)
                        if j < PER_THEME: b[j] = row[:8]
    rows = {}
    for t, b in buckets.items():
        for row in b: rows[row[0]] = row
    with gzip.open(dst, 'wt', encoding='utf-8', newline='') as o:
        w = csv.writer(o); w.writerow(header[:8])
        for row in rows.values(): w.writerow(row)
    print('puzzles kept', len(rows), {t: len(b) for t, b in buckets.items()})
