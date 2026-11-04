// MOTH Engine — an original chess engine compiled to freestanding WebAssembly (no libc, no allocator).
//
//   Board        bitboards + mailbox, incremental Zobrist keys, incremental NNUE accumulators
//   Movegen      fully legal (pseudo-legal + king-safety filter), castling / en passant / promotion
//   Search       iterative deepening (driven per-iteration from JS), aspiration windows, PVS, quiescence
//                with check evasions, transposition table, null-move pruning, late-move reductions,
//                reverse futility pruning, check extensions, killer + history heuristics, SEE,
//                mate-distance scoring, repetition / 50-move / insufficient-material draws, MultiPV
//   Evaluation   tapered classical evaluation (material, PST, mobility, king safety, pawn structure,
//                passed pawns, space/initiative) shaped by the playing style, plus an optional
//                NNUE-style residual network (768 → 2×H → 1, clipped ReLU) trained offline
//   Styles       Aggressive / Balanced / Defensive share this search and this network; they only
//                re-weight evaluation terms and add a bounded root tie-break bonus (never applied to
//                mate scores), so forced wins and necessary defences are never overridden.
//
// Square numbering: a1 = 0 … h8 = 63. Colours: 0 = white, 1 = black. Pieces: P N B R Q K = 0..5.

typedef unsigned long long u64;
typedef unsigned int u32;
typedef unsigned short u16;
typedef unsigned char u8;
typedef signed char i8;
typedef short i16;

#define EXPORT(name) __attribute__((export_name(#name)))
#define IMPORT(name) __attribute__((import_module("env"), import_name(#name)))

extern "C" {
IMPORT(now_ms) double js_now_ms();
// freestanding helpers clang may emit calls to
void* memset(void* d, int c, unsigned long n) { u8* p = (u8*)d; while (n--) *p++ = (u8)c; return d; }
void* memcpy(void* d, const void* s, unsigned long n) { u8* a = (u8*)d; const u8* b = (const u8*)s; while (n--) *a++ = *b++; return d; }
void* memmove(void* d, const void* s, unsigned long n) {
  u8* a = (u8*)d; const u8* b = (const u8*)s;
  if (a < b) while (n--) *a++ = *b++; else { a += n; b += n; while (n--) *--a = *--b; }
  return d;
}
}

static inline int lsb(u64 b) { return __builtin_ctzll(b); }
static inline int msb(u64 b) { return 63 - __builtin_clzll(b); }
static inline int popcnt(u64 b) { return __builtin_popcountll(b); }
static inline int pop_lsb(u64& b) { int s = lsb(b); b &= b - 1; return s; }
static inline u64 bit(int s) { return 1ULL << s; }
static inline int file_of(int s) { return s & 7; }
static inline int rank_of(int s) { return s >> 3; }
static inline int imax(int a, int b) { return a > b ? a : b; }
static inline int imin(int a, int b) { return a < b ? a : b; }
static inline int iabs(int a) { return a < 0 ? -a : a; }

enum { PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, NO_TYPE = 6 };
enum { WHITE, BLACK };
static const int NO_PIECE = 12;
static inline int make_piece(int c, int t) { return c * 6 + t; }
static inline int color_of(int p) { return p >= 6; }
static inline int type_of(int p) { return p % 6; }

// ─── move encoding ────────────────────────────────────────────────────────────
// bits 0-5 from, 6-11 to, 12-14 promotion type (0 none, else piece type N..Q), 15-16 flag
enum { F_NONE = 0, F_EP = 1, F_CASTLE = 2, F_DOUBLE = 3 };
typedef u32 Move;
static inline Move mk(int f, int t, int promo = 0, int flag = 0) { return (u32)f | ((u32)t << 6) | ((u32)promo << 12) | ((u32)flag << 15); }
static inline int m_from(Move m) { return m & 63; }
static inline int m_to(Move m) { return (m >> 6) & 63; }
static inline int m_promo(Move m) { return (m >> 12) & 7; }
static inline int m_flag(Move m) { return (m >> 15) & 3; }

// ─── tables ───────────────────────────────────────────────────────────────────
static u64 KNIGHT_ATT[64], KING_ATT[64], PAWN_ATT[2][64], RAYS[8][64], BETWEEN_FILE[8], ADJ_FILES[8];
static u64 PASSED_MASK[2][64], FORWARD_FILE[2][64], KING_ZONE[2][64];
static const int DIRS[8] = { 8, 1, -8, -1, 9, 7, -7, -9 }; // N E S W NE NW SE SW
static const int DFILE[8] = { 0, 1, 0, -1, 1, -1, 1, -1 };
static const int DRANK[8] = { 1, 0, -1, 0, 1, 1, -1, -1 };
static u64 ZOB_PIECE[12][64], ZOB_SIDE, ZOB_CASTLE[16], ZOB_EP[8];
static u64 rng_state = 0x9E3779B97F4A7C15ULL;
static u64 rnd64() { rng_state ^= rng_state >> 12; rng_state ^= rng_state << 25; rng_state ^= rng_state >> 27; return rng_state * 2685821657736338717ULL; }

static void init_tables() {
  for (int s = 0; s < 64; s++) {
    int f = file_of(s), r = rank_of(s);
    u64 n = 0, k = 0;
    const int kn[8][2] = { {1,2},{2,1},{2,-1},{1,-2},{-1,-2},{-2,-1},{-2,1},{-1,2} };
    for (int i = 0; i < 8; i++) { int ff = f + kn[i][0], rr = r + kn[i][1]; if (ff >= 0 && ff < 8 && rr >= 0 && rr < 8) n |= bit(rr * 8 + ff); }
    for (int df = -1; df <= 1; df++) for (int dr = -1; dr <= 1; dr++) { if (!df && !dr) continue; int ff = f + df, rr = r + dr; if (ff >= 0 && ff < 8 && rr >= 0 && rr < 8) k |= bit(rr * 8 + ff); }
    KNIGHT_ATT[s] = n; KING_ATT[s] = k;
    PAWN_ATT[WHITE][s] = 0; PAWN_ATT[BLACK][s] = 0;
    if (r < 7) { if (f > 0) PAWN_ATT[WHITE][s] |= bit(s + 7); if (f < 7) PAWN_ATT[WHITE][s] |= bit(s + 9); }
    if (r > 0) { if (f > 0) PAWN_ATT[BLACK][s] |= bit(s - 9); if (f < 7) PAWN_ATT[BLACK][s] |= bit(s - 7); }
    for (int d = 0; d < 8; d++) {
      u64 ray = 0; int ff = f + DFILE[d], rr = r + DRANK[d];
      while (ff >= 0 && ff < 8 && rr >= 0 && rr < 8) { ray |= bit(rr * 8 + ff); ff += DFILE[d]; rr += DRANK[d]; }
      RAYS[d][s] = ray;
    }
  }
  for (int f = 0; f < 8; f++) {
    u64 m = 0; for (int r = 0; r < 8; r++) m |= bit(r * 8 + f);
    BETWEEN_FILE[f] = m;
  }
  for (int f = 0; f < 8; f++) ADJ_FILES[f] = (f > 0 ? BETWEEN_FILE[f - 1] : 0) | (f < 7 ? BETWEEN_FILE[f + 1] : 0);
  for (int s = 0; s < 64; s++) {
    int f = file_of(s), r = rank_of(s);
    u64 wf = 0, bf = 0;
    for (int rr = r + 1; rr < 8; rr++) wf |= bit(rr * 8 + f);
    for (int rr = r - 1; rr >= 0; rr--) bf |= bit(rr * 8 + f);
    FORWARD_FILE[WHITE][s] = wf; FORWARD_FILE[BLACK][s] = bf;
    u64 wp = 0, bp = 0;
    for (int ff = imax(0, f - 1); ff <= imin(7, f + 1); ff++) {
      for (int rr = r + 1; rr < 8; rr++) wp |= bit(rr * 8 + ff);
      for (int rr = r - 1; rr >= 0; rr--) bp |= bit(rr * 8 + ff);
    }
    PASSED_MASK[WHITE][s] = wp; PASSED_MASK[BLACK][s] = bp;
    u64 z = KING_ATT[s] | bit(s);
    KING_ZONE[WHITE][s] = z | (r < 6 ? (z << 8) : 0);
    KING_ZONE[BLACK][s] = z | (r > 1 ? (z >> 8) : 0);
  }
  for (int p = 0; p < 12; p++) for (int s = 0; s < 64; s++) ZOB_PIECE[p][s] = rnd64();
  ZOB_SIDE = rnd64();
  for (int i = 0; i < 16; i++) ZOB_CASTLE[i] = rnd64();
  for (int i = 0; i < 8; i++) ZOB_EP[i] = rnd64();
}

static inline u64 ray_att(int d, int s, u64 occ) {
  u64 ray = RAYS[d][s], blk = ray & occ;
  if (!blk) return ray;
  int b = (DIRS[d] > 0) ? lsb(blk) : msb(blk);
  return ray ^ RAYS[d][b];
}
static inline u64 rook_att(int s, u64 occ) { return ray_att(0, s, occ) | ray_att(1, s, occ) | ray_att(2, s, occ) | ray_att(3, s, occ); }
static inline u64 bishop_att(int s, u64 occ) { return ray_att(4, s, occ) | ray_att(5, s, occ) | ray_att(6, s, occ) | ray_att(7, s, occ); }

// ─── NNUE residual network ───────────────────────────────────────────────────
static const int NN_IN = 768;
static const int NN_MAXH = 128;
static int nn_h = 0;           // 0 = no network loaded (pure classical evaluation)
static float nn_scale = 100.f; // network output units → centipawns
// The network is a bounded residual on top of the classical evaluation: it refines positional judgement
// but can never override material by more than NN_CLAMP centipawns (keeps search robust off-distribution).
static const int NN_CLAMP = 250;
static float NN_W1[NN_IN * NN_MAXH];
static float NN_B1[NN_MAXH];
static float NN_W2[2 * NN_MAXH];
static float NN_B2 = 0.f;
static inline int nn_feature(int persp, int piece, int sq) {
  int rel_c = (color_of(piece) == persp) ? 0 : 1;
  int rel_s = persp == WHITE ? sq : (sq ^ 56);
  return (rel_c * 6 + type_of(piece)) * 64 + rel_s;
}

// ─── position ────────────────────────────────────────────────────────────────
static const int MAX_PLY = 128;
static const int MAX_HIST = 1024;
struct Undo { Move move; u8 captured; u8 castle; i8 ep; u8 half; u64 key; };
struct Pos {
  u8 sq[64];
  u64 bb[2][6];
  u64 occ[2];
  int side, castle, ep, half, full;
  u64 key;
};
static Pos P;
static Undo UNDO[MAX_HIST];
static u64 KEYS[MAX_HIST]; // key history for repetition detection
static int hply = 0;        // number of moves made from the root FEN (game + search)
static float ACC[MAX_HIST + 1][2][NN_MAXH];

static inline u64 all_occ() { return P.occ[0] | P.occ[1]; }
static inline u64 pieces(int c, int t) { return P.bb[c][t]; }
static inline int king_sq(int c) { return lsb(P.bb[c][KING]); }

static inline void acc_add(int piece, int s) {
  if (!nn_h) return;
  float* a0 = ACC[hply][0]; float* a1 = ACC[hply][1];
  const float* w0 = &NN_W1[nn_feature(0, piece, s) * nn_h];
  const float* w1 = &NN_W1[nn_feature(1, piece, s) * nn_h];
  for (int i = 0; i < nn_h; i++) { a0[i] += w0[i]; a1[i] += w1[i]; }
}
static inline void acc_sub(int piece, int s) {
  if (!nn_h) return;
  float* a0 = ACC[hply][0]; float* a1 = ACC[hply][1];
  const float* w0 = &NN_W1[nn_feature(0, piece, s) * nn_h];
  const float* w1 = &NN_W1[nn_feature(1, piece, s) * nn_h];
  for (int i = 0; i < nn_h; i++) { a0[i] -= w0[i]; a1[i] -= w1[i]; }
}
static void acc_refresh() {
  if (!nn_h) return;
  for (int p = 0; p < 2; p++) for (int i = 0; i < nn_h; i++) ACC[hply][p][i] = NN_B1[i];
  for (int s = 0; s < 64; s++) if (P.sq[s] != NO_PIECE) acc_add(P.sq[s], s);
}

static inline void put(int piece, int s) {
  P.sq[s] = (u8)piece; P.bb[color_of(piece)][type_of(piece)] |= bit(s); P.occ[color_of(piece)] |= bit(s);
  P.key ^= ZOB_PIECE[piece][s];
}
static inline void remove(int s) {
  int piece = P.sq[s];
  P.bb[color_of(piece)][type_of(piece)] &= ~bit(s); P.occ[color_of(piece)] &= ~bit(s); P.sq[s] = NO_PIECE;
  P.key ^= ZOB_PIECE[piece][s];
}

static u64 attackers_to(int s, u64 occ) {
  return (PAWN_ATT[BLACK][s] & P.bb[WHITE][PAWN]) | (PAWN_ATT[WHITE][s] & P.bb[BLACK][PAWN])
       | (KNIGHT_ATT[s] & (P.bb[0][KNIGHT] | P.bb[1][KNIGHT]))
       | (KING_ATT[s] & (P.bb[0][KING] | P.bb[1][KING]))
       | (bishop_att(s, occ) & (P.bb[0][BISHOP] | P.bb[1][BISHOP] | P.bb[0][QUEEN] | P.bb[1][QUEEN]))
       | (rook_att(s, occ) & (P.bb[0][ROOK] | P.bb[1][ROOK] | P.bb[0][QUEEN] | P.bb[1][QUEEN]));
}
static inline bool attacked_by(int s, int by) {
  u64 occ = all_occ();
  if (PAWN_ATT[by ^ 1][s] & P.bb[by][PAWN]) return true;
  if (KNIGHT_ATT[s] & P.bb[by][KNIGHT]) return true;
  if (KING_ATT[s] & P.bb[by][KING]) return true;
  if (bishop_att(s, occ) & (P.bb[by][BISHOP] | P.bb[by][QUEEN])) return true;
  if (rook_att(s, occ) & (P.bb[by][ROOK] | P.bb[by][QUEEN])) return true;
  return false;
}
static inline bool in_check() { return attacked_by(king_sq(P.side), P.side ^ 1); }

// castling rights update mask: rights &= CR_MASK[from] & CR_MASK[to]
static int CR_MASK[64];

static void make_move(Move m) {
  Undo& u = UNDO[hply];
  u.move = m; u.castle = (u8)P.castle; u.ep = (i8)P.ep; u.half = (u8)imin(P.half, 255); u.key = P.key;
  KEYS[hply] = P.key;
  int from = m_from(m), to = m_to(m), flag = m_flag(m), promo = m_promo(m);
  int piece = P.sq[from], us = P.side, them = us ^ 1;
  int captured = (flag == F_EP) ? make_piece(them, PAWN) : P.sq[to];
  u.captured = (u8)captured;
  if (nn_h) for (int p = 0; p < 2; p++) for (int i = 0; i < nn_h; i++) ACC[hply + 1][p][i] = ACC[hply][p][i];
  hply++;
  if (P.ep >= 0) P.key ^= ZOB_EP[file_of(P.ep)];
  P.key ^= ZOB_CASTLE[P.castle];
  if (flag == F_EP) { int cs = to + (us == WHITE ? -8 : 8); acc_sub(P.sq[cs], cs); remove(cs); }
  else if (captured != NO_PIECE) { acc_sub(captured, to); remove(to); }
  acc_sub(piece, from); remove(from);
  int placed = promo ? make_piece(us, promo) : piece;
  put(placed, to); acc_add(placed, to);
  if (flag == F_CASTLE) {
    int rf, rt;
    if (to > from) { rf = from + 3; rt = from + 1; } else { rf = from - 4; rt = from - 1; }
    int rook = P.sq[rf];
    acc_sub(rook, rf); remove(rf); put(rook, rt); acc_add(rook, rt);
  }
  P.castle &= CR_MASK[from] & CR_MASK[to];
  P.ep = -1;
  if (flag == F_DOUBLE) {
    int eps = (from + to) / 2;
    // only record e.p. square when a capture is actually possible (keeps keys canonical)
    if (PAWN_ATT[us][eps] & P.bb[them][PAWN]) P.ep = eps;
  }
  if (P.ep >= 0) P.key ^= ZOB_EP[file_of(P.ep)];
  P.key ^= ZOB_CASTLE[P.castle];
  P.half = (type_of(piece) == PAWN || captured != NO_PIECE) ? 0 : P.half + 1;
  if (us == BLACK) P.full++;
  P.side = them; P.key ^= ZOB_SIDE;
}

static void unmake_move() {
  hply--;
  Undo& u = UNDO[hply];
  Move m = u.move;
  int from = m_from(m), to = m_to(m), flag = m_flag(m), promo = m_promo(m);
  P.side ^= 1;
  int us = P.side;
  if (us == BLACK) P.full--;
  if (flag == F_CASTLE) {
    int rf, rt;
    if (to > from) { rf = from + 3; rt = from + 1; } else { rf = from - 4; rt = from - 1; }
    int rook = P.sq[rt]; remove(rt); put(rook, rf);
  }
  int placed = P.sq[to];
  remove(to);
  put(promo ? make_piece(us, PAWN) : placed, from);
  if (flag == F_EP) put(u.captured, to + (us == WHITE ? -8 : 8));
  else if (u.captured != NO_PIECE) put(u.captured, to);
  P.castle = u.castle; P.ep = u.ep; P.half = u.half; P.key = u.key;
}

static void make_null() {
  Undo& u = UNDO[hply];
  u.move = 0; u.castle = (u8)P.castle; u.ep = (i8)P.ep; u.half = (u8)imin(P.half, 255); u.key = P.key; u.captured = NO_PIECE;
  KEYS[hply] = P.key;
  if (nn_h) for (int p = 0; p < 2; p++) for (int i = 0; i < nn_h; i++) ACC[hply + 1][p][i] = ACC[hply][p][i];
  hply++;
  if (P.ep >= 0) P.key ^= ZOB_EP[file_of(P.ep)];
  P.ep = -1; P.half++;
  P.side ^= 1; P.key ^= ZOB_SIDE;
}
static void unmake_null() {
  hply--;
  Undo& u = UNDO[hply];
  P.side ^= 1; P.ep = u.ep; P.half = u.half; P.key = u.key;
}

// ─── move generation ──────────────────────────────────────────────────────────
struct MoveList { Move m[256]; int score[256]; int n; };
static inline void add(MoveList& l, Move m) { l.m[l.n++] = m; }

static void gen_pawn(MoveList& l, bool captures_only) {
  int us = P.side, them = us ^ 1;
  u64 pawns = P.bb[us][PAWN], empty = ~all_occ(), enemy = P.occ[them];
  int up = us == WHITE ? 8 : -8;
  u64 rank7 = us == WHITE ? 0x00FF000000000000ULL : 0x000000000000FF00ULL;
  u64 rank3 = us == WHITE ? 0x0000000000FF0000ULL : 0x0000FF0000000000ULL;
  u64 b = pawns;
  while (b) {
    int s = pop_lsb(b);
    bool promo = bit(s) & rank7;
    int t = s + up;
    if (bit(t) & empty) {
      if (promo) { for (int pr = QUEEN; pr >= KNIGHT; pr--) add(l, mk(s, t, pr)); }
      else if (!captures_only) {
        add(l, mk(s, t));
        if ((bit(t) & rank3) && (bit(t + up) & empty)) add(l, mk(s, t + up, 0, F_DOUBLE));
      }
    }
    u64 caps = PAWN_ATT[us][s] & enemy;
    while (caps) {
      int c = pop_lsb(caps);
      if (promo) { for (int pr = QUEEN; pr >= KNIGHT; pr--) add(l, mk(s, c, pr)); }
      else add(l, mk(s, c));
    }
    if (P.ep >= 0 && (PAWN_ATT[us][s] & bit(P.ep))) add(l, mk(s, P.ep, 0, F_EP));
  }
}

static void gen_pseudo(MoveList& l, bool captures_only) {
  l.n = 0;
  int us = P.side, them = us ^ 1;
  u64 occ = all_occ(), own = P.occ[us], target = captures_only ? P.occ[them] : ~own;
  gen_pawn(l, captures_only);
  for (int t = KNIGHT; t <= KING; t++) {
    u64 b = P.bb[us][t];
    while (b) {
      int s = pop_lsb(b);
      u64 a = t == KNIGHT ? KNIGHT_ATT[s] : t == BISHOP ? bishop_att(s, occ) : t == ROOK ? rook_att(s, occ) : t == QUEEN ? (bishop_att(s, occ) | rook_att(s, occ)) : KING_ATT[s];
      a &= target;
      while (a) add(l, mk(s, pop_lsb(a)));
    }
  }
  if (!captures_only) {
    int k = king_sq(us);
    if (us == WHITE && k == 4) {
      if ((P.castle & 1) && !(occ & 0x60ULL) && !attacked_by(4, them) && !attacked_by(5, them) && !attacked_by(6, them)) add(l, mk(4, 6, 0, F_CASTLE));
      if ((P.castle & 2) && !(occ & 0x0EULL) && !attacked_by(4, them) && !attacked_by(3, them) && !attacked_by(2, them)) add(l, mk(4, 2, 0, F_CASTLE));
    } else if (us == BLACK && k == 60) {
      if ((P.castle & 4) && !(occ & 0x6000000000000000ULL) && !attacked_by(60, them) && !attacked_by(61, them) && !attacked_by(62, them)) add(l, mk(60, 62, 0, F_CASTLE));
      if ((P.castle & 8) && !(occ & 0x0E00000000000000ULL) && !attacked_by(60, them) && !attacked_by(59, them) && !attacked_by(58, them)) add(l, mk(60, 58, 0, F_CASTLE));
    }
  }
}

// make the move; returns false (and unmakes) if it leaves our king in check
static inline bool make_legal(Move m) {
  int us = P.side;
  make_move(m);
  if (attacked_by(king_sq(us), us ^ 1)) { unmake_move(); return false; }
  return true;
}

static int gen_legal(MoveList& out) {
  MoveList l; gen_pseudo(l, false);
  out.n = 0;
  for (int i = 0; i < l.n; i++) if (make_legal(l.m[i])) { unmake_move(); out.m[out.n++] = l.m[i]; }
  return out.n;
}

static u64 perft(int depth) {
  if (depth == 0) return 1;
  MoveList l; gen_pseudo(l, false);
  u64 n = 0;
  for (int i = 0; i < l.n; i++) {
    if (!make_legal(l.m[i])) continue;
    n += depth == 1 ? 1 : perft(depth - 1);
    unmake_move();
  }
  return n;
}

// ─── FEN / UCI strings ────────────────────────────────────────────────────────
static const char PIECE_CH[13] = "PNBRQKpnbrqk";
static bool set_fen(const char* f) {
  Pos np; for (int i = 0; i < 64; i++) np.sq[i] = NO_PIECE;
  for (int c = 0; c < 2; c++) { np.occ[c] = 0; for (int t = 0; t < 6; t++) np.bb[c][t] = 0; }
  P = np; P.key = 0;
  int r = 7, fl = 0; const char* p = f;
  while (*p && *p != ' ') {
    char ch = *p++;
    if (ch == '/') { r--; fl = 0; if (r < 0) return false; continue; }
    if (ch >= '1' && ch <= '8') { fl += ch - '0'; if (fl > 8) return false; continue; }
    int pc = -1; for (int i = 0; i < 12; i++) if (PIECE_CH[i] == ch) pc = i;
    if (pc < 0 || fl > 7) return false;
    put(pc, r * 8 + fl); fl++;
  }
  if (popcnt(P.bb[0][KING]) != 1 || popcnt(P.bb[1][KING]) != 1) return false;
  while (*p == ' ') p++;
  P.side = (*p == 'b') ? BLACK : WHITE; if (*p) p++;
  while (*p == ' ') p++;
  P.castle = 0;
  while (*p && *p != ' ') { char ch = *p++; if (ch == 'K') P.castle |= 1; else if (ch == 'Q') P.castle |= 2; else if (ch == 'k') P.castle |= 4; else if (ch == 'q') P.castle |= 8; }
  // drop impossible castling rights instead of trusting them
  if (P.sq[4] != make_piece(WHITE, KING)) P.castle &= ~3;
  if (P.sq[7] != make_piece(WHITE, ROOK)) P.castle &= ~1;
  if (P.sq[0] != make_piece(WHITE, ROOK)) P.castle &= ~2;
  if (P.sq[60] != make_piece(BLACK, KING)) P.castle &= ~12;
  if (P.sq[63] != make_piece(BLACK, ROOK)) P.castle &= ~4;
  if (P.sq[56] != make_piece(BLACK, ROOK)) P.castle &= ~8;
  while (*p == ' ') p++;
  P.ep = -1;
  if (*p >= 'a' && *p <= 'h' && p[1] >= '1' && p[1] <= '8') {
    int eps = (p[1] - '1') * 8 + (p[0] - 'a');
    if (PAWN_ATT[P.side ^ 1][eps] & P.bb[P.side][PAWN]) P.ep = eps;
    p += 2;
  } else if (*p) p++;
  while (*p == ' ') p++;
  P.half = 0; while (*p >= '0' && *p <= '9') P.half = P.half * 10 + (*p++ - '0');
  while (*p == ' ') p++;
  P.full = 0; while (*p >= '0' && *p <= '9') P.full = P.full * 10 + (*p++ - '0');
  if (P.full < 1) P.full = 1;
  if (P.side == BLACK) P.key ^= ZOB_SIDE;
  P.key ^= ZOB_CASTLE[P.castle];
  if (P.ep >= 0) P.key ^= ZOB_EP[file_of(P.ep)];
  hply = 0;
  // side not to move must not be in check
  if (attacked_by(king_sq(P.side ^ 1), P.side)) return false;
  acc_refresh();
  return true;
}

static int write_int(char* o, long long v) {
  char tmp[24]; int n = 0, len = 0;
  if (v < 0) { o[len++] = '-'; v = -v; }
  do { tmp[n++] = (char)('0' + v % 10); v /= 10; } while (v);
  while (n) o[len++] = tmp[--n];
  return len;
}
static int get_fen(char* o) {
  int len = 0;
  for (int r = 7; r >= 0; r--) {
    int empty = 0;
    for (int f = 0; f < 8; f++) {
      int pc = P.sq[r * 8 + f];
      if (pc == NO_PIECE) { empty++; continue; }
      if (empty) { o[len++] = (char)('0' + empty); empty = 0; }
      o[len++] = PIECE_CH[pc];
    }
    if (empty) o[len++] = (char)('0' + empty);
    if (r) o[len++] = '/';
  }
  o[len++] = ' '; o[len++] = P.side == WHITE ? 'w' : 'b'; o[len++] = ' ';
  if (!P.castle) o[len++] = '-';
  if (P.castle & 1) o[len++] = 'K'; if (P.castle & 2) o[len++] = 'Q'; if (P.castle & 4) o[len++] = 'k'; if (P.castle & 8) o[len++] = 'q';
  o[len++] = ' ';
  if (P.ep >= 0) { o[len++] = (char)('a' + file_of(P.ep)); o[len++] = (char)('1' + rank_of(P.ep)); } else o[len++] = '-';
  o[len++] = ' '; len += write_int(o + len, P.half);
  o[len++] = ' '; len += write_int(o + len, P.full);
  o[len] = 0;
  return len;
}
static int move_uci(Move m, char* o) {
  int f = m_from(m), t = m_to(m), len = 0;
  o[len++] = (char)('a' + file_of(f)); o[len++] = (char)('1' + rank_of(f));
  o[len++] = (char)('a' + file_of(t)); o[len++] = (char)('1' + rank_of(t));
  if (m_promo(m)) o[len++] = " nbrq"[m_promo(m)];
  o[len] = 0;
  return len;
}
static Move parse_uci(const char* s) {
  MoveList l; gen_legal(l);
  char buf[8];
  for (int i = 0; i < l.n; i++) {
    int n = move_uci(l.m[i], buf);
    bool eq = true;
    for (int k = 0; k < n; k++) if (buf[k] != s[k]) { eq = false; break; }
    if (eq && (s[n] == 0 || s[n] == ' ')) return l.m[i];
  }
  return 0;
}

// SAN for a legal move in the current position (with +/# suffix)
static int move_san(Move m, char* o) {
  int from = m_from(m), to = m_to(m), pc = P.sq[from], t = type_of(pc), len = 0;
  bool cap = P.sq[to] != NO_PIECE || m_flag(m) == F_EP;
  if (m_flag(m) == F_CASTLE) { const char* c = to > from ? "O-O" : "O-O-O"; while (*c) o[len++] = *c++; }
  else {
    if (t != PAWN) {
      o[len++] = "PNBRQK"[t];
      MoveList l; gen_legal(l);
      bool sameFile = false, sameRank = false, ambiguous = false;
      for (int i = 0; i < l.n; i++) {
        Move x = l.m[i];
        if (x == m || m_to(x) != to || P.sq[m_from(x)] != pc) continue;
        ambiguous = true;
        if (file_of(m_from(x)) == file_of(from)) sameFile = true;
        if (rank_of(m_from(x)) == rank_of(from)) sameRank = true;
      }
      if (ambiguous) {
        if (!sameFile) o[len++] = (char)('a' + file_of(from));
        else if (!sameRank) o[len++] = (char)('1' + rank_of(from));
        else { o[len++] = (char)('a' + file_of(from)); o[len++] = (char)('1' + rank_of(from)); }
      }
    } else if (cap) o[len++] = (char)('a' + file_of(from));
    if (cap) o[len++] = 'x';
    o[len++] = (char)('a' + file_of(to)); o[len++] = (char)('1' + rank_of(to));
    if (m_promo(m)) { o[len++] = '='; o[len++] = " NBRQ"[m_promo(m)]; }
  }
  make_move(m);
  if (in_check()) { MoveList l; o[len++] = gen_legal(l) ? '+' : '#'; }
  unmake_move();
  o[len] = 0;
  return len;
}

// ─── evaluation ───────────────────────────────────────────────────────────────
// Piece-square tables (from White's point of view, a1 = index 0). Values in centipawns.
static const int MG_VAL[6] = { 82, 337, 365, 477, 1025, 0 };
static const int EG_VAL[6] = { 94, 281, 297, 512, 936, 0 };
static const int SEE_VAL[7] = { 100, 320, 330, 500, 950, 20000, 0 };
static const int PST_MG[6][64] = {
  { 0,0,0,0,0,0,0,0, -35,-1,-20,-23,-15,24,38,-22, -26,-4,-4,-10,3,3,33,-12, -27,-2,-5,12,17,6,10,-25,
    -14,13,6,21,23,12,17,-23, -6,7,26,31,65,56,25,-20, 98,134,61,95,68,126,34,-11, 0,0,0,0,0,0,0,0 },
  { -105,-21,-58,-33,-17,-28,-19,-23, -29,-53,-12,-3,-1,18,-14,-19, -23,-9,12,10,19,17,25,-16, -13,4,16,13,28,19,21,-8,
    -9,17,19,53,37,69,18,22, -47,60,37,65,84,129,73,44, -73,-41,72,36,23,62,7,-17, -167,-89,-34,-49,61,-97,-15,-107 },
  { -33,-3,-14,-21,-13,-12,-39,-21, 4,15,16,0,7,21,33,1, 0,15,15,15,14,27,18,10, -6,13,13,26,34,12,10,4,
    -4,5,19,50,37,37,7,-2, -16,37,43,40,35,50,37,-2, -26,16,-18,-13,30,59,18,-47, -29,4,-82,-37,-25,-42,7,-8 },
  { -19,-13,1,17,16,7,-37,-26, -44,-16,-20,-9,-1,11,-6,-71, -45,-25,-16,-17,3,0,-5,-33, -36,-26,-12,-1,9,-7,6,-23,
    -24,-11,7,26,24,35,-8,-20, -5,19,26,36,17,45,61,16, 27,32,58,62,80,67,26,44, 32,42,32,51,63,9,31,43 },
  { -1,-18,-9,10,-15,-25,-31,-50, -35,-8,11,2,8,15,-3,1, -14,2,-11,-2,-5,2,14,5, -9,-26,-9,-10,-2,-4,3,-3,
    -27,-27,-16,-16,-1,17,-2,1, -13,-17,7,8,29,56,47,57, -24,-39,-5,1,-16,57,28,54, -28,0,29,12,59,44,43,45 },
  { -15,36,12,-54,8,-28,24,14, 1,7,-8,-64,-43,-16,9,8, -14,-14,-22,-46,-44,-30,-15,-27, -49,-1,-27,-39,-46,-44,-33,-51,
    -17,-20,-12,-27,-30,-25,-14,-36, -9,24,2,-16,-20,6,22,-22, 29,-1,-20,-7,-8,-4,-38,-29, -65,23,16,-15,-56,-34,2,13 },
};
static const int PST_EG[6][64] = {
  { 0,0,0,0,0,0,0,0, 13,8,8,10,13,0,2,-7, 4,7,-6,1,0,-5,-1,-8, 13,9,-3,-7,-7,-8,3,-1,
    32,24,13,5,-2,4,17,17, 94,100,85,67,56,53,82,84, 178,173,158,134,147,132,165,187, 0,0,0,0,0,0,0,0 },
  { -29,-51,-23,-15,-22,-18,-50,-64, -42,-20,-10,-5,-2,-20,-23,-44, -23,-3,-1,15,10,-3,-20,-22, -18,-6,16,25,16,17,4,-18,
    -17,3,22,22,22,11,8,-18, -24,-20,10,9,-1,-9,-19,-41, -25,-8,-25,-2,-9,-25,-24,-52, -58,-38,-13,-28,-31,-27,-63,-99 },
  { -23,-9,-23,-5,-9,-16,-5,-17, -14,-18,-7,-1,4,-9,-15,-27, -12,-3,8,10,13,3,-7,-15, -6,3,13,19,7,10,-3,-9,
    -3,9,12,9,14,10,3,2, 2,-8,0,-1,-2,6,0,4, -8,-4,7,-12,-3,-13,-4,-14, -14,-21,-11,-8,-7,-9,-17,-24 },
  { -9,2,3,-1,-5,-13,4,-20, -6,-6,0,2,-9,-9,-11,-3, -4,0,-5,-1,-7,-12,-8,-16, 3,5,8,4,-5,-6,-8,-11,
    4,3,13,1,2,1,-1,2, 7,7,7,5,4,-3,-5,-3, 11,13,13,11,-3,3,8,3, 13,10,18,15,12,12,8,5 },
  { -33,-28,-22,-43,-5,-32,-20,-41, -22,-23,-30,-16,-16,-23,-36,-32, -16,-27,15,6,9,17,10,5, -18,28,19,47,31,34,39,23,
    3,22,24,45,57,40,57,36, -20,6,9,49,47,35,19,9, -17,20,32,41,58,25,30,0, -9,22,22,27,27,19,10,20 },
  { -53,-34,-21,-11,-28,-14,-24,-43, -27,-11,4,13,14,4,-5,-17, -19,-3,11,21,23,16,7,-9, -18,-4,21,24,27,23,9,-11,
    -8,22,24,27,26,33,26,3, 10,17,23,15,20,45,44,13, -12,17,14,17,17,38,23,11, -74,-35,-18,-18,-11,15,4,-17 },
};
static const int PHASE_W[6] = { 0, 1, 1, 2, 4, 0 };

// Style weights (percent). All styles use the same terms; only the emphasis changes.
struct Style { int king_attack, king_shelter, mobility, passed, structure, space, contempt, root_bonus; };
static const Style STYLES[3] = {
  /* Aggressive */ { 135, 85, 115, 95, 90, 140, 12, 1 },
  /* Balanced   */ { 100, 100, 100, 100, 100, 100, 0, 0 },
  /* Defensive  */ { 80, 140, 95, 105, 120, 80, -6, 2 },
};
static int style_id = 1;
static const int KING_ATTACK_TABLE[16] = { 0, 0, 12, 30, 55, 85, 120, 160, 200, 240, 280, 310, 330, 345, 355, 360 };

static int eval_classical() {
  const Style& st = STYLES[style_id];
  int mg[2] = { 0, 0 }, eg[2] = { 0, 0 }, phase = 0;
  u64 occ = all_occ();
  u64 pawn_att[2];
  {
    u64 wp = P.bb[WHITE][PAWN], bp = P.bb[BLACK][PAWN];
    pawn_att[WHITE] = ((wp & ~BETWEEN_FILE[0]) << 7) | ((wp & ~BETWEEN_FILE[7]) << 9);
    pawn_att[BLACK] = ((bp & ~BETWEEN_FILE[0]) >> 9) | ((bp & ~BETWEEN_FILE[7]) >> 7);
  }
  int katt_count[2] = { 0, 0 }, katt_weight[2] = { 0, 0 };
  for (int c = 0; c < 2; c++) {
    int them = c ^ 1;
    int ek = king_sq(them);
    u64 zone = KING_ZONE[them][ek];
    u64 safe = ~P.occ[c] & ~pawn_att[them];
    for (int t = 0; t < 6; t++) {
      u64 b = P.bb[c][t];
      while (b) {
        int s = pop_lsb(b);
        int ps = c == WHITE ? s : (s ^ 56);
        mg[c] += MG_VAL[t] + PST_MG[t][ps];
        eg[c] += EG_VAL[t] + PST_EG[t][ps];
        phase += PHASE_W[t];
        if (t == PAWN || t == KING) continue;
        u64 a = t == KNIGHT ? KNIGHT_ATT[s] : t == BISHOP ? bishop_att(s, occ) : t == ROOK ? rook_att(s, occ) : (bishop_att(s, occ) | rook_att(s, occ));
        int mob = popcnt(a & safe);
        static const int MOB_MG[6] = { 0, 4, 5, 2, 1, 0 }, MOB_EG[6] = { 0, 4, 5, 4, 2, 0 }, MOB_BASE[6] = { 0, 4, 6, 6, 12, 0 };
        mg[c] += (MOB_MG[t] * (mob - MOB_BASE[t])) * st.mobility / 100;
        eg[c] += (MOB_EG[t] * (mob - MOB_BASE[t])) * st.mobility / 100;
        u64 za = a & zone;
        if (za) { katt_count[c]++; katt_weight[c] += popcnt(za) * (t == QUEEN ? 4 : t == ROOK ? 3 : 2); }
        if (t == ROOK) {
          u64 fm = BETWEEN_FILE[file_of(s)];
          if (!(fm & P.bb[c][PAWN])) { if (!(fm & P.bb[them][PAWN])) { mg[c] += 25; eg[c] += 10; } else { mg[c] += 12; eg[c] += 6; } }
        }
        // space / activity: minor and major pieces established in the enemy half
        if (t != QUEEN && ((c == WHITE && rank_of(s) >= 4) || (c == BLACK && rank_of(s) <= 3))) mg[c] += 6 * st.space / 100;
      }
    }
    if (popcnt(P.bb[c][BISHOP]) >= 2) { mg[c] += 30; eg[c] += 50; }
    // pawn structure
    u64 pw = P.bb[c][PAWN], b = pw;
    int structure_mg = 0, structure_eg = 0, passed_mg = 0, passed_eg = 0;
    while (b) {
      int s = pop_lsb(b);
      int f = file_of(s), rr = c == WHITE ? rank_of(s) : 7 - rank_of(s);
      if (FORWARD_FILE[c][s] & pw) { structure_mg -= 10; structure_eg -= 20; }
      if (!(ADJ_FILES[f] & pw)) { structure_mg -= 12; structure_eg -= 15; }
      if (!(PASSED_MASK[c][s] & P.bb[them][PAWN])) {
        static const int PMG[8] = { 0, 5, 10, 18, 32, 55, 95, 0 }, PEG[8] = { 0, 12, 20, 38, 65, 110, 170, 0 };
        int pm = PMG[rr], pe = PEG[rr];
        int stop = s + (c == WHITE ? 8 : -8);
        if (stop >= 0 && stop < 64 && (bit(stop) & occ)) { pm /= 2; pe /= 2; }
        // king proximity in the endgame
        int ourk = king_sq(c), theirk = king_sq(them);
        int dist_us = imax(iabs(file_of(ourk) - f), iabs(rank_of(ourk) - rank_of(stop & 63)));
        int dist_them = imax(iabs(file_of(theirk) - f), iabs(rank_of(theirk) - rank_of(stop & 63)));
        pe += (dist_them - dist_us) * 5 * rr / 3;
        passed_mg += pm; passed_eg += pe;
      }
    }
    mg[c] += structure_mg * st.structure / 100 + passed_mg * st.passed / 100;
    eg[c] += structure_eg * st.structure / 100 + passed_eg * st.passed / 100;
    // king shelter (middlegame): pawns in front of our king
    int k = king_sq(c), kf = file_of(k);
    int shelter = 0;
    for (int f = imax(0, kf - 1); f <= imin(7, kf + 1); f++) {
      u64 fp = BETWEEN_FILE[f] & pw & PASSED_MASK[c][k];
      if (!fp) { shelter -= 18; if (!(BETWEEN_FILE[f] & P.bb[them][PAWN])) shelter -= 10; }
      else { int ps = c == WHITE ? lsb(fp) : msb(fp); int dist = iabs(rank_of(ps) - rank_of(k)); shelter += dist <= 1 ? 10 : dist == 2 ? 4 : 0; }
    }
    mg[c] += shelter * st.king_shelter / 100;
  }
  for (int c = 0; c < 2; c++) {
    int n = imin(katt_count[c], 7), w = imin(katt_weight[c], 15);
    if (n >= 2 && P.bb[c][QUEEN]) { int att = KING_ATTACK_TABLE[w] * (n + 1) / 8; mg[c] += att * st.king_attack / 100; }
    else if (n >= 1) mg[c] += KING_ATTACK_TABLE[w] / 6 * st.king_attack / 100;
  }
  int us = P.side;
  int mgs = mg[us] - mg[us ^ 1] + 15; // tempo
  int egs = eg[us] - eg[us ^ 1];
  if (phase > 24) phase = 24;
  int score = (mgs * phase + egs * (24 - phase)) / 24;
  // drawish material: scale down when the stronger side cannot win
  int strong = score > 0 ? us : us ^ 1;
  if (!P.bb[strong][PAWN]) {
    int minor = popcnt(P.bb[strong][KNIGHT] | P.bb[strong][BISHOP]), major = popcnt(P.bb[strong][ROOK] | P.bb[strong][QUEEN]);
    if (!major && minor <= 1) score /= 16;
  }
  return score;
}

static int eval_nnue() {
  if (!nn_h) return 0;
  const float* a = ACC[hply][P.side];
  const float* b = ACC[hply][P.side ^ 1];
  float s = NN_B2;
  for (int i = 0; i < nn_h; i++) {
    float x = a[i]; x = x < 0.f ? 0.f : x > 1.f ? 1.f : x;
    float y = b[i]; y = y < 0.f ? 0.f : y > 1.f ? 1.f : y;
    s += x * NN_W2[i] + y * NN_W2[nn_h + i];
  }
  int cp = (int)(s * nn_scale);
  return imax(-NN_CLAMP, imin(NN_CLAMP, cp));
}

static bool insufficient_material() {
  if (P.bb[0][PAWN] | P.bb[1][PAWN] | P.bb[0][ROOK] | P.bb[1][ROOK] | P.bb[0][QUEEN] | P.bb[1][QUEEN]) return false;
  int minors = popcnt(P.bb[0][KNIGHT] | P.bb[1][KNIGHT] | P.bb[0][BISHOP] | P.bb[1][BISHOP]);
  return minors <= 1;
}

static inline int evaluate() { return eval_classical() + eval_nnue(); }

// ─── static exchange evaluation ───────────────────────────────────────────────
static int see(Move m) {
  int from = m_from(m), to = m_to(m);
  if (m_flag(m) == F_CASTLE) return 0;
  int gain[32], d = 0;
  int captured = m_flag(m) == F_EP ? PAWN : (P.sq[to] == NO_PIECE ? NO_TYPE : type_of(P.sq[to]));
  u64 occ = all_occ() ^ bit(from);
  if (m_flag(m) == F_EP) occ ^= bit(to + (P.side == WHITE ? -8 : 8));
  gain[0] = SEE_VAL[captured] + (m_promo(m) ? SEE_VAL[m_promo(m)] - SEE_VAL[PAWN] : 0);
  int attacker = m_promo(m) ? m_promo(m) : type_of(P.sq[from]);
  int side = P.side ^ 1;
  u64 att = attackers_to(to, occ) & occ;
  u64 diag = P.bb[0][BISHOP] | P.bb[1][BISHOP] | P.bb[0][QUEEN] | P.bb[1][QUEEN];
  u64 orth = P.bb[0][ROOK] | P.bb[1][ROOK] | P.bb[0][QUEEN] | P.bb[1][QUEEN];
  while (true) {
    u64 mine = att & P.occ[side];
    if (!mine) break;
    int t; u64 b = 0;
    for (t = PAWN; t <= KING; t++) { b = mine & P.bb[side][t]; if (b) break; }
    if (t == KING && (att & P.occ[side ^ 1])) break; // king cannot capture into a defended square
    d++;
    if (d >= 31) break;
    gain[d] = SEE_VAL[attacker] - gain[d - 1];
    attacker = t;
    occ ^= bit(lsb(b));
    att |= (bishop_att(to, occ) & diag) | (rook_att(to, occ) & orth);
    att &= occ;
    side ^= 1;
  }
  while (d) { gain[d - 1] = -imax(-gain[d - 1], gain[d]); d--; }
  return gain[0];
}

// ─── transposition table ─────────────────────────────────────────────────────
struct TTEntry { u32 key32; u16 move; i16 score; i16 eval; u8 depth; u8 flag_age; };
enum { TT_NONE = 0, TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3 };
static TTEntry* TT = 0;
static u32 tt_mask = 0;
static u8 tt_age = 0;
static const int MATE = 32000, MATE_BOUND = 31000, INF = 32500;

static unsigned long tt_capacity = 0;
static void tt_alloc(int mb) {
  if (mb < 1) mb = 1; if (mb > 256) mb = 256;
  unsigned long bytes = (unsigned long)mb << 20;
  u32 n = 1; while ((unsigned long)(n * 2) * sizeof(TTEntry) <= bytes) n *= 2;
  unsigned long need = (unsigned long)n * sizeof(TTEntry);
  if (need > tt_capacity) {
    long old = __builtin_wasm_memory_grow(0, (need + 65535) / 65536);
    if (old >= 0) { TT = (TTEntry*)(old * 65536UL); tt_capacity = need; }
    else if (!TT) { // could not grow at all: fall back to a small table
      old = __builtin_wasm_memory_grow(0, 16);
      if (old < 0) return;
      TT = (TTEntry*)(old * 65536UL); tt_capacity = 16 * 65536UL;
    }
    while ((unsigned long)n * sizeof(TTEntry) > tt_capacity) n /= 2;
  }
  tt_mask = n - 1;
  memset(TT, 0, (unsigned long)n * sizeof(TTEntry));
}
static inline int score_to_tt(int s, int ply) { return s > MATE_BOUND ? s + ply : s < -MATE_BOUND ? s - ply : s; }
static inline int score_from_tt(int s, int ply) { return s > MATE_BOUND ? s - ply : s < -MATE_BOUND ? s + ply : s; }
static inline TTEntry* tt_probe(u64 key) { return &TT[(u32)key & tt_mask]; }
static void tt_store(u64 key, int depth, int score, int flag, Move m, int ev, int ply) {
  TTEntry* e = tt_probe(key);
  u32 k32 = (u32)(key >> 32);
  int oldAge = e->flag_age >> 2;
  if (e->key32 == k32 || oldAge != tt_age || depth >= e->depth || flag == TT_EXACT) {
    if (!m && e->key32 == k32) m = e->move;
    e->key32 = k32; e->move = (u16)(m & 0xFFFF); e->score = (i16)score_to_tt(score, ply); e->eval = (i16)ev;
    e->depth = (u8)imax(0, depth); e->flag_age = (u8)(flag | (tt_age << 2));
  }
}
// TT stores 16 move bits: from/to/promo + low flag bit. Recover the full move from the legal list.
static inline bool same_move16(Move full, u16 m16) { return (full & 0xFFFF) == m16; }

// ─── search ───────────────────────────────────────────────────────────────────
static Move KILLERS[MAX_PLY][2];
static int HISTORY[2][64][64];
static Move PV[MAX_PLY][MAX_PLY];
static int PV_LEN[MAX_PLY];
static u64 nodes = 0, node_limit = 0;
static double deadline = 0;
static bool aborted = false;
static int seldepth = 0;
static int root_hply = 0;
static int root_side = 0;
// draw score from the side to move's view: a style with positive contempt avoids draws for the root side
static inline int draw_score();
static Move root_excluded[16];
static int root_excluded_n = 0;

static inline void check_time() {
  if ((nodes & 1023) == 0) {
    if (deadline > 0 && js_now_ms() >= deadline) aborted = true;
    if (node_limit && nodes >= node_limit) aborted = true;
  }
}

static bool is_repetition() {
  // look back over reversible moves only; any repetition inside the search tree, or a 3-fold in game history
  int count = 0;
  for (int i = hply - 2; i >= 0 && i >= hply - P.half; i -= 2) {
    if (KEYS[i] == P.key) {
      if (i >= root_hply) return true; // repetition within search → draw
      if (++count >= 2) return true;   // third occurrence including game history
    }
  }
  return false;
}

static void score_moves(MoveList& l, Move ttMove, int ply) {
  for (int i = 0; i < l.n; i++) {
    Move m = l.m[i];
    int sc;
    int victim = m_flag(m) == F_EP ? PAWN : (P.sq[m_to(m)] == NO_PIECE ? NO_TYPE : type_of(P.sq[m_to(m)]));
    if (ttMove && same_move16(m, (u16)ttMove)) sc = 1 << 30;
    else if (victim != NO_TYPE || m_promo(m) == QUEEN) {
      int s = see(m);
      sc = (s >= 0 ? (1 << 28) : (1 << 20)) + SEE_VAL[victim == NO_TYPE ? 6 : victim] * 16 - SEE_VAL[type_of(P.sq[m_from(m)])] / 16 + (m_promo(m) == QUEEN ? 5000 : 0);
    }
    else if (m == KILLERS[ply][0]) sc = (1 << 26) + 2;
    else if (m == KILLERS[ply][1]) sc = (1 << 26) + 1;
    else sc = HISTORY[P.side][m_from(m)][m_to(m)];
    l.score[i] = sc;
  }
}
static inline Move pick(MoveList& l, int i) {
  int best = i;
  for (int j = i + 1; j < l.n; j++) if (l.score[j] > l.score[best]) best = j;
  Move m = l.m[best]; int s = l.score[best];
  l.m[best] = l.m[i]; l.score[best] = l.score[i]; l.m[i] = m; l.score[i] = s;
  return m;
}

static int qsearch(int alpha, int beta, int ply) {
  nodes++; check_time();
  if (aborted) return 0;
  if (ply > seldepth) seldepth = ply;
  if (ply >= MAX_PLY - 1) return evaluate();
  bool check = in_check();
  int stand = -INF;
  if (!check) {
    stand = evaluate();
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
  }
  MoveList l; gen_pseudo(l, !check);
  score_moves(l, 0, ply);
  int legal = 0, best = check ? -INF : stand;
  for (int i = 0; i < l.n; i++) {
    Move m = pick(l, i);
    if (!check) {
      if (l.score[i] < (1 << 28) && !m_promo(m)) continue; // losing captures (SEE < 0) are skipped
      int victim = m_flag(m) == F_EP ? PAWN : type_of(P.sq[m_to(m)]);
      if (!m_promo(m) && stand + SEE_VAL[victim] + 200 < alpha) continue; // delta pruning
    }
    if (!make_legal(m)) continue;
    legal++;
    int s = -qsearch(-beta, -alpha, ply + 1);
    unmake_move();
    if (aborted) return 0;
    if (s > best) { best = s; if (s > alpha) { alpha = s; if (s >= beta) break; } }
  }
  if (check && !legal) return -MATE + ply;
  return best;
}

static int root_bonus(Move m);
static inline int draw_score() { int c = STYLES[style_id].contempt; return P.side == root_side ? -c : c; }

static int search(int alpha, int beta, int depth, int ply, bool pv, bool nullOk) {
  PV_LEN[ply] = ply;
  bool root = ply == 0;
  if (!root) {
    if (P.half >= 100 || is_repetition() || insufficient_material()) return draw_score();
    // mate distance pruning
    int ma = imax(alpha, -MATE + ply), mb = imin(beta, MATE - ply - 1);
    if (ma >= mb) return ma;
  }
  bool check = in_check();
  if (check) depth++;
  if (depth <= 0) return qsearch(alpha, beta, ply);
  nodes++; check_time();
  if (aborted) return 0;
  if (ply >= MAX_PLY - 1) return evaluate();

  TTEntry* e = tt_probe(P.key);
  Move ttMove = 0;
  int ttEval = -INF;
  if (e->key32 == (u32)(P.key >> 32)) {
    ttMove = e->move;
    ttEval = e->eval;
    int ts = score_from_tt(e->score, ply), flag = e->flag_age & 3;
    if (!pv && e->depth >= depth && !root) {
      if (flag == TT_EXACT || (flag == TT_LOWER && ts >= beta) || (flag == TT_UPPER && ts <= alpha)) return ts;
    }
  }
  int static_eval = check ? -INF : (ttEval != -INF ? ttEval : evaluate());

  if (!pv && !check && !root) {
    // reverse futility pruning
    if (depth <= 6 && static_eval - 80 * depth >= beta && iabs(beta) < MATE_BOUND) return static_eval;
    // null move pruning
    u64 nonpawn = P.occ[P.side] & ~P.bb[P.side][PAWN] & ~P.bb[P.side][KING];
    if (nullOk && depth >= 3 && static_eval >= beta && nonpawn) {
      int R = 3 + depth / 5;
      make_null();
      int s = -search(-beta, -beta + 1, depth - 1 - R, ply + 1, false, false);
      unmake_null();
      if (aborted) return 0;
      if (s >= beta) return s >= MATE_BOUND ? beta : s;
    }
  }

  MoveList l; gen_pseudo(l, false);
  score_moves(l, ttMove, ply);
  int legal = 0, best = -INF, origAlpha = alpha;
  Move bestMove = 0;
  for (int i = 0; i < l.n; i++) {
    Move m = pick(l, i);
    if (root) { bool ex = false; for (int k = 0; k < root_excluded_n; k++) if (root_excluded[k] == m) ex = true; if (ex) continue; }
    bool quiet = P.sq[m_to(m)] == NO_PIECE && m_flag(m) != F_EP && !m_promo(m);
    // late move pruning of quiet moves at shallow depth
    if (!root && !pv && !check && quiet && legal >= 4 + depth * depth && best > -MATE_BOUND) continue;
    if (!make_legal(m)) continue;
    legal++;
    PV_LEN[ply + 1] = ply + 1;
    int bonus = root ? root_bonus(m) : 0;
    bool givesCheck = in_check();
    int s;
    if (legal == 1) s = -search(-beta + bonus, -alpha + bonus, depth - 1, ply + 1, pv, true) + bonus;
    else {
      int r = 0;
      if (depth >= 3 && quiet && !check && !givesCheck && legal > 3) {
        r = 1 + (legal > 8) + (depth > 7) - (pv ? 1 : 0);
        if (m == KILLERS[ply][0] || m == KILLERS[ply][1]) r--;
        if (r < 0) r = 0;
        if (r > depth - 2) r = depth - 2;
      }
      s = -search(-alpha - 1 + bonus, -alpha + bonus, depth - 1 - r, ply + 1, false, true) + bonus;
      if (s > alpha && r) s = -search(-alpha - 1 + bonus, -alpha + bonus, depth - 1, ply + 1, false, true) + bonus;
      if (s > alpha && s < beta) s = -search(-beta + bonus, -alpha + bonus, depth - 1, ply + 1, true, true) + bonus;
    }
    unmake_move();
    if (aborted) return 0;
    if (s > best) {
      best = s; bestMove = m;
      if (s > alpha) {
        alpha = s;
        PV[ply][ply] = m;
        for (int k = ply + 1; k < PV_LEN[ply + 1]; k++) PV[ply][k] = PV[ply + 1][k];
        PV_LEN[ply] = PV_LEN[ply + 1] > ply + 1 ? PV_LEN[ply + 1] : ply + 1;
        if (s >= beta) {
          if (quiet) {
            if (KILLERS[ply][0] != m) { KILLERS[ply][1] = KILLERS[ply][0]; KILLERS[ply][0] = m; }
            int& h = HISTORY[P.side][m_from(m)][m_to(m)];
            h += depth * depth; if (h > (1 << 24)) for (int a = 0; a < 2; a++) for (int b = 0; b < 64; b++) for (int c = 0; c < 64; c++) HISTORY[a][b][c] /= 2;
          }
          break;
        }
      }
    }
  }
  if (!legal) {
    if (root && root_excluded_n) return -INF; // no more root moves for this MultiPV slot
    return check ? -MATE + ply : draw_score();
  }
  int flag = best >= beta ? TT_LOWER : (alpha > origAlpha ? TT_EXACT : TT_UPPER);
  if (!(root && root_excluded_n)) tt_store(P.key, depth, best, flag, bestMove, static_eval == -INF ? 0 : static_eval, ply);
  return best;
}

// Style root bonus: a few centipawns for moves matching the style's preferences. Never applied when
// the position is already decided (mate scores), and small enough that it can only choose between
// moves the search considers practically equal.
static int root_style_ctx_eval = 0;
static int root_bonus(Move m) {
  // called after make_move: the side to move is the opponent; m was played by P.side ^ 1
  int st = style_id;
  if (st == 1 || iabs(root_style_ctx_eval) > 400) return 0;
  int us = P.side ^ 1, them = P.side;
  int to = m_to(m), from = m_from(m);
  int moved = P.sq[to];
  int b = 0;
  bool capture = UNDO[hply - 1].captured != NO_PIECE;
  bool check = in_check();
  int ek = king_sq(them), ok = king_sq(us);
  int dist_ek = imax(iabs(file_of(to) - file_of(ek)), iabs(rank_of(to) - rank_of(ek)));
  if (st == 0) { // aggressive
    if (check) b += 6;
    if (capture) b += 3;
    if (dist_ek <= 2) b += 4;
    if ((us == WHITE && rank_of(to) > rank_of(from)) || (us == BLACK && rank_of(to) < rank_of(from))) b += 2;
    if (type_of(moved) == PAWN && iabs(file_of(to) - file_of(ek)) <= 1) b += 3;
  } else { // defensive
    int dist_ok = imax(iabs(file_of(to) - file_of(ok)), iabs(rank_of(to) - rank_of(ok)));
    if (dist_ok <= 2 && type_of(moved) != KING) b += 4;
    if (m_flag(m) == F_CASTLE) b += 8;
    if (capture && root_style_ctx_eval > 50) b += 5; // simplify when ahead
    if (type_of(moved) == PAWN && iabs(file_of(to) - file_of(ok)) <= 1 && rank_of(ok) == (us == WHITE ? 0 : 7)) b -= 4; // keep shelter
  }
  return imin(b, 12);
}

// ─── root driver (one iteration per call, iterative deepening driven from JS) ─
static const int MAX_LINES = 8;
struct Line { Move pv[MAX_PLY]; int len; int score; int depth; int bound; };
static Line LINES[MAX_LINES];
static int lines_n = 0;
static int prev_scores[MAX_LINES];
static bool have_prev = false;

static void search_begin() {
  tt_age = (u8)((tt_age + 1) & 63);
  for (int i = 0; i < MAX_PLY; i++) KILLERS[i][0] = KILLERS[i][1] = 0;
  for (int a = 0; a < 2; a++) for (int b = 0; b < 64; b++) for (int c = 0; c < 64; c++) HISTORY[a][b][c] /= 8;
  nodes = 0; seldepth = 0; lines_n = 0; have_prev = false; aborted = false;
  root_hply = hply;
  root_side = P.side;
  root_style_ctx_eval = eval_classical();
}

// Runs one iteration at `depth` for `multipv` lines. Returns 1 if completed, 0 if aborted (previous
// lines remain valid). The deadline is absolute (performance.now() milliseconds).
static int search_iteration(int depth, int multipv, double dl, u64 nlimit) {
  deadline = dl; node_limit = nlimit ? nodes + nlimit : 0; aborted = false;
  Line next[MAX_LINES]; int got = 0;
  root_excluded_n = 0;
  for (int k = 0; k < multipv && k < MAX_LINES; k++) {
    int alpha = -INF, beta = INF, delta = 30;
    if (have_prev && depth >= 5 && k < lines_n && iabs(prev_scores[k]) < MATE_BOUND) { alpha = prev_scores[k] - delta; beta = prev_scores[k] + delta; }
    int s;
    while (true) {
      seldepth = 0;
      s = search(alpha, beta, depth, 0, true, false);
      if (aborted) break;
      if (s <= alpha && alpha > -INF) { alpha = imax(-INF, alpha - delta); delta *= 2; continue; }
      if (s >= beta && beta < INF) { beta = imin(INF, beta + delta); delta *= 2; continue; }
      break;
    }
    if (aborted) break;
    if (s == -INF || PV_LEN[0] == 0) break; // fewer legal moves than requested lines
    Line& L = next[got++];
    L.len = PV_LEN[0]; for (int i = 0; i < L.len; i++) L.pv[i] = PV[0][i];
    L.score = s; L.depth = depth; L.bound = 0;
    root_excluded[root_excluded_n++] = PV[0][0];
  }
  if (aborted && got == 0) return 0;
  // a partially completed MultiPV iteration still improves line 1 (searched first with full window)
  for (int i = 0; i < got; i++) { LINES[i] = next[i]; prev_scores[i] = next[i].score; }
  if (got > lines_n || !aborted) lines_n = got > lines_n ? got : lines_n;
  if (!aborted) { lines_n = got; have_prev = true; }
  return aborted ? 0 : 1;
}

// ─── exported API ─────────────────────────────────────────────────────────────
static char IO[1 << 16];
static bool initialised = false;

extern "C" {
EXPORT(mc_io) char* mc_io() { return IO; }
EXPORT(mc_init) int mc_init(int hashMb) {
  if (!initialised) {
    init_tables();
    for (int s = 0; s < 64; s++) CR_MASK[s] = 15;
    CR_MASK[4] &= ~3; CR_MASK[7] &= ~1; CR_MASK[0] &= ~2; CR_MASK[60] &= ~12; CR_MASK[63] &= ~4; CR_MASK[56] &= ~8;
    initialised = true;
  }
  tt_alloc(hashMb);
  set_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  return 1;
}
EXPORT(mc_new_game) void mc_new_game() {
  if (TT) memset(TT, 0, (unsigned long)(tt_mask + 1) * sizeof(TTEntry));
  memset(HISTORY, 0, sizeof(HISTORY));
}
/** Set position from the FEN in IO. Returns 1 on success. */
EXPORT(mc_set_fen) int mc_set_fen() { return set_fen(IO) ? 1 : 0; }
/** Play the UCI move in IO. Returns 1 if legal. */
EXPORT(mc_play_uci) int mc_play_uci() { Move m = parse_uci(IO); if (!m) return 0; make_move(m); return 1; }
/** Undo the last played move. */
EXPORT(mc_undo) int mc_undo() { if (hply <= 0) return 0; unmake_move(); return 1; }
EXPORT(mc_get_fen) int mc_get_fen() { return get_fen(IO); }
/** Space-separated legal moves in UCI into IO; returns count. */
EXPORT(mc_legal_uci) int mc_legal_uci() {
  MoveList l; gen_legal(l);
  int len = 0;
  for (int i = 0; i < l.n; i++) { len += move_uci(l.m[i], IO + len); IO[len++] = ' '; }
  IO[len] = 0;
  return l.n;
}
/** SAN of the UCI move in IO, written back to IO. Returns length or 0 if illegal. */
EXPORT(mc_uci_to_san) int mc_uci_to_san() { Move m = parse_uci(IO); if (!m) return 0; return move_san(m, IO); }
/** Parse SAN in IO (annotations tolerated); writes UCI back. Returns length or 0. */
EXPORT(mc_san_to_uci) int mc_san_to_uci() {
  char want[16]; int n = 0;
  for (const char* p = IO; *p && n < 15; p++) {
    char c = *p;
    if (c == '+' || c == '#' || c == '!' || c == '?') continue;
    if (c == '0') c = 'O';
    want[n++] = c;
  }
  want[n] = 0;
  // tolerate missing '=' in promotions (e8Q)
  MoveList l; gen_legal(l);
  char san[16];
  for (int i = 0; i < l.n; i++) {
    move_san(l.m[i], san);
    char clean[16]; int k = 0;
    for (const char* p = san; *p; p++) if (*p != '+' && *p != '#') clean[k++] = *p;
    clean[k] = 0;
    bool eq = true; int a = 0, b = 0;
    while (clean[a] || want[b]) {
      if (clean[a] == '=' && want[b] != '=') { a++; continue; }
      if (clean[a] != want[b]) { eq = false; break; }
      a++; b++;
    }
    if (eq) return move_uci(l.m[i], IO);
  }
  return 0;
}
/**
 * Quiet position (training filter): not in check and no legal capture/promotion that wins material by
 * static exchange. Evaluation targets from a search are only comparable to a static evaluation there.
 */
EXPORT(mc_quiet) int mc_quiet() {
  if (in_check()) return 0;
  MoveList l; gen_pseudo(l, true);
  for (int i = 0; i < l.n; i++) {
    Move m = l.m[i];
    if (!(m_promo(m) || see(m) > 0)) continue;
    if (make_legal(m)) { unmake_move(); return 0; }
  }
  return 1;
}
EXPORT(mc_side) int mc_side() { return P.side; }
EXPORT(mc_in_check) int mc_in_check() { return in_check() ? 1 : 0; }
/** 0 ongoing, 1 checkmate, 2 stalemate, 3 fifty-move, 4 repetition, 5 insufficient material */
EXPORT(mc_game_state) int mc_game_state() {
  MoveList l;
  if (!gen_legal(l)) return in_check() ? 1 : 2;
  if (P.half >= 100) return 3;
  int count = 0;
  for (int i = hply - 2; i >= 0 && i >= hply - P.half; i -= 2) if (KEYS[i] == P.key) count++;
  if (count >= 2) return 4;
  if (insufficient_material()) return 5;
  return 0;
}
EXPORT(mc_key_lo) u32 mc_key_lo() { return (u32)P.key; }
EXPORT(mc_key_hi) u32 mc_key_hi() { return (u32)(P.key >> 32); }
EXPORT(mc_perft) double mc_perft(int depth) { return (double)perft(depth); }
EXPORT(mc_eval) int mc_eval() { return evaluate(); }
EXPORT(mc_eval_classical) int mc_eval_classical() { return eval_classical(); }
EXPORT(mc_eval_nnue) int mc_eval_nnue() { return eval_nnue(); }
EXPORT(mc_see_uci) int mc_see_uci() { Move m = parse_uci(IO); return m ? see(m) : 0; }
EXPORT(mc_set_style) void mc_set_style(int s) { style_id = s < 0 ? 0 : s > 2 ? 2 : s; }
EXPORT(mc_get_style) int mc_get_style() { return style_id; }
EXPORT(mc_hashfull) int mc_hashfull() {
  if (!TT) return 0;
  int used = 0; for (int i = 0; i < 1000; i++) if (TT[i].key32 && (TT[i].flag_age >> 2) == tt_age) used++;
  return used;
}

// network loading: weights are written by JS into the buffer returned by mc_nn_buffer, in order
// W1[768*H], B1[H], W2[2H], B2, scale. H = 0 disables the network.
EXPORT(mc_nn_buffer) float* mc_nn_buffer() { return NN_W1; }
EXPORT(mc_nn_b1) float* mc_nn_b1() { return NN_B1; }
EXPORT(mc_nn_w2) float* mc_nn_w2() { return NN_W2; }
EXPORT(mc_nn_max_hidden) int mc_nn_max_hidden() { return NN_MAXH; }
EXPORT(mc_nn_set) int mc_nn_set(int h, float b2, float scale) {
  if (h < 0 || h > NN_MAXH) return 0;
  // W1 is written densely as [768][h] at the start of NN_W1
  nn_h = h; NN_B2 = b2; nn_scale = scale;
  acc_refresh();
  return 1;
}
EXPORT(mc_nn_hidden) int mc_nn_hidden() { return nn_h; }
/** Active NNUE feature indices for both perspectives (for training): IO as int32[]: n, white[n], black[n]. */
EXPORT(mc_features) int mc_features() {
  int* o = (int*)IO; int n = 0;
  for (int s = 0; s < 64; s++) if (P.sq[s] != NO_PIECE) n++;
  o[0] = n; int a = 1, b = 1 + n;
  for (int s = 0; s < 64; s++) if (P.sq[s] != NO_PIECE) { o[a++] = nn_feature(0, P.sq[s], s); o[b++] = nn_feature(1, P.sq[s], s); }
  return n;
}

EXPORT(mc_search_begin) void mc_search_begin() { search_begin(); }
EXPORT(mc_search_iteration) int mc_search_iteration(int depth, int multipv, double deadline_ms, double node_budget) {
  return search_iteration(depth, multipv, deadline_ms, (u64)node_budget);
}
EXPORT(mc_lines) int mc_lines() { return lines_n; }
EXPORT(mc_line_score) int mc_line_score(int i) { return LINES[i].score; }
EXPORT(mc_line_depth) int mc_line_depth(int i) { return LINES[i].depth; }
/** PV of line i as space-separated UCI into IO. */
EXPORT(mc_line_pv) int mc_line_pv(int i) {
  int len = 0;
  for (int k = 0; k < LINES[i].len; k++) { len += move_uci(LINES[i].pv[k], IO + len); IO[len++] = ' '; }
  if (len) len--;
  IO[len] = 0;
  return len;
}
EXPORT(mc_nodes) double mc_nodes() { return (double)nodes; }
EXPORT(mc_seldepth) int mc_seldepth() { return seldepth; }
EXPORT(mc_mate_value) int mc_mate_value() { return MATE; }
EXPORT(mc_mate_bound) int mc_mate_bound() { return MATE_BOUND; }
}
