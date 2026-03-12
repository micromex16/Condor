// ═══════════════════════════════════════════════════════════════════
// condor-supabase.js
// ═══════════════════════════════════════════════════════════════════

const SUPABASE_URL  = 'https://oixvlmgtzllsepzfhple.supabase.co';
const SUPABASE_ANON = 'sb_publishable_qlUNqtQH-9jaeeYJZd3Rbw_hU3MNInY';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// ─────────────────────────────────────────────────────────────────
// AUTH HELPERS
// ─────────────────────────────────────────────────────────────────

async function signInWithGoogle() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href }
  });
  if (error) console.error('Google sign-in error:', error.message);
}

async function signInWithEmail(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function signUpWithEmail(email, password, username) {
  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { data: { full_name: username } }
  });
  if (error) throw error;
  return data;
}

async function signOut() {
  await sb.auth.signOut();
}

async function getCurrentUser() {
  const { data: { user } } = await sb.auth.getUser();
  return user;
}

async function getMyProfile() {
  const user = await getCurrentUser();
  if (!user) return null;
  const { data, error } = await sb
    .from('players')
    .select('*')
    .eq('id', user.id)
    .single();
  if (error) throw error;
  return data;
}

async function updateMyProfile({ username, hdcp_index }) {
  const user = await getCurrentUser();
  if (!user) throw new Error('Not logged in');
  const updates = {};
  if (username   !== undefined) updates.username   = username;
  if (hdcp_index !== undefined) updates.hdcp_index = hdcp_index;
  const { data, error } = await sb
    .from('players')
    .update(updates)
    .eq('id', user.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN')  onUserSignedIn(session.user);
  if (event === 'SIGNED_OUT') onUserSignedOut();
});

function onUserSignedIn(user)  { console.log('Signed in:', user.email); }
function onUserSignedOut()     { console.log('Signed out'); }


// ─────────────────────────────────────────────────────────────────
// ROUND SAVING
// ─────────────────────────────────────────────────────────────────

async function saveRound() {
  if (state.roundSaved) return;                    // duplicate-save guard
  const user = await getCurrentUser();
  if (!user) throw new Error('Must be logged in to save rounds');

  const { optimized: debts } = calcDebts();
  const playerMoney = state.players.map((_, i) => {
    let m = 0;
    debts.forEach(d => {
      if (d.to   === i) m += d.amount;
      if (d.from === i) m -= d.amount;
    });
    return Math.round(m);
  });

  const playerStats = state.players.map((p, i) => {
    let gross = 0, eagles = 0, birdies = 0, pars_ = 0, bogeys = 0, dbls = 0;
    let front = 0, back = 0, validHoles = 0;
    const tee = getPlayerTee(i);

    for (let h = 0; h < state.holesCount; h++) {
      const g = state.scores[i]?.[h];
      if (g == null) continue;
      validHoles++;
      gross += g;
      if (h < 9) front += g; else back += g;
      const diff = g - tee.holes[h].par;
      if (diff <= -2) eagles++;
      else if (diff === -1) birdies++;
      else if (diff ===  0) pars_++;
      else if (diff ===  1) bogeys++;
      else dbls++;
    }

    const net   = gross - (state.playingHandicaps[i] || 0);
    const toPar = gross - (tee.par || 72);

    return {
      // identity — use accountId directly, never name-match
      _accountId:   p.accountId || null,
      _isGuest:     p.isGuest   || false,
      _guestName:   p.isGuest   ? p.name : null,
      player_name:  p.name,
      hdcp_index:   p.hdcp,
      playing_hdcp: state.playingHandicaps[i] || 0,
      tee_label:    tee.label,
      gross_score:  validHoles > 0 ? gross : null,
      net_score:    validHoles > 0 ? net   : null,
      to_par:       validHoles > 0 ? toPar : null,
      front_gross:  validHoles > 0 ? front : null,
      back_gross:   validHoles > 0 ? back  : null,
      eagles, birdies,
      pars:         pars_,
      bogeys,
      doubles_plus: dbls,
      money_result: playerMoney[i],
    };
  });

  const validPlayers = playerStats
    .map((s, i) => ({ i, net: s.net_score }))
    .filter(x => x.net != null)
    .sort((a, b) => a.net - b.net);
  validPlayers.forEach((x, rank) => { playerStats[x.i].finish_position = rank + 1; });

  const gamesPlayed = Object.entries(state.games)
    .filter(([, on]) => on)
    .map(([k]) => k);

  const primaryTee = state.course.teeSets[state.selectedTee ?? 0];

  const { data: round, error: roundErr } = await sb
    .from('rounds')
    .insert({
      created_by:   user.id,
      course_name:  state.course.name,
      course_id:    state.course.id || null,
      played_at:    new Date().toISOString().split('T')[0],
      holes_played: state.holesCount,
      tee_label:    primaryTee?.label || null,
      format:       state.teamFormat || 'individual',
      games_played: gamesPlayed,
      full_state:   state,
      is_complete:  true,
    })
    .select()
    .single();

  if (roundErr) throw roundErr;

  const roundPlayerRows = playerStats.map((stats) => {
    // Pull out the private identity fields, don't send to DB
    const { _accountId, _isGuest, _guestName, ...dbStats } = stats;
    return {
      round_id:    round.id,
      player_id:   _accountId,   // null for guests — canonical, no name-matching
      is_guest:    _isGuest,
      guest_name:  _guestName,
      ...dbStats,
    };
  });

  const { error: rpErr } = await sb.from('round_players').insert(roundPlayerRows);
  if (rpErr) throw rpErr;

  console.log('Round saved:', round.id);
  state.roundSaved = true;
  return round.id;
}


// ─────────────────────────────────────────────────────────────────
// ROUND HISTORY
// ─────────────────────────────────────────────────────────────────

async function getMyRounds(limit = 20) {
  const user = await getCurrentUser();
  if (!user) return [];
  const { data, error } = await sb
    .from('round_players')
    .select(`
      round_id, gross_score, net_score, to_par, money_result, finish_position,
      rounds ( id, course_name, played_at, tee_label, format, games_played, full_state )
    `)
    .eq('player_id', user.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

async function getRoundState(roundId) {
  const { data, error } = await sb
    .from('rounds')
    .select('full_state, course_name, played_at')
    .eq('id', roundId)
    .single();
  if (error) throw error;
  return data;
}

async function getRoundPlayers(roundId) {
  const { data, error } = await sb
    .from('round_players')
    .select('*, players(username, avatar_url)')
    .eq('round_id', roundId)
    .order('finish_position', { ascending: true });
  if (error) throw error;
  return data;
}


// ─────────────────────────────────────────────────────────────────
// LEADERBOARDS
// ─────────────────────────────────────────────────────────────────

async function getMoneyLeaderboard() {
  const { data, error } = await sb.from('v_leaderboard_money').select('*');
  if (error) throw error;
  return data;
}

async function getScoringLeaderboard() {
  const { data, error } = await sb.from('v_leaderboard_scoring').select('*');
  if (error) throw error;
  return data;
}

async function getHeadToHead(opponentId) {
  const user = await getCurrentUser();
  if (!user) return null;
  const [p1, p2] = [user.id, opponentId].sort();
  const { data, error } = await sb
    .from('v_head_to_head')
    .select('*')
    .eq('p1_id', p1)
    .eq('p2_id', p2)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || { rounds_together: 0, p1_wins: 0, p2_wins: 0, ties: 0 };
}


// ─────────────────────────────────────────────────────────────────
// FRIENDS
// ─────────────────────────────────────────────────────────────────

async function searchPlayers(query) {
  const { data, error } = await sb
    .from('players')
    .select('id, username, avatar_url, hdcp_index')
    .ilike('username', `%${query}%`)
    .limit(20);
  if (error) throw error;
  return data;
}

async function sendFriendRequest(toPlayerId) {
  const user = await getCurrentUser();
  if (!user) throw new Error('Not logged in');
  const { data, error } = await sb
    .from('friends')
    .insert({ from_id: user.id, to_id: toPlayerId, status: 'pending' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function acceptFriendRequest(friendRowId) {
  const { data, error } = await sb
    .from('friends')
    .update({ status: 'accepted' })
    .eq('id', friendRowId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getMyFriends() {
  const user = await getCurrentUser();
  if (!user) return [];
  const { data, error } = await sb
    .from('friends')
    .select(`
      id, status, created_at,
      from_player:from_id ( id, username, avatar_url, hdcp_index ),
      to_player:to_id     ( id, username, avatar_url, hdcp_index )
    `)
    .or(`from_id.eq.${user.id},to_id.eq.${user.id}`)
    .eq('status', 'accepted');
  if (error) throw error;
  return data.map(row => {
    const other = row.from_player.id === user.id ? row.to_player : row.from_player;
    return { ...other, friendship_id: row.id };
  });
}

async function getPendingRequests() {
  const user = await getCurrentUser();
  if (!user) return [];
  const { data, error } = await sb
    .from('friends')
    .select(`id, created_at, from_player:from_id ( id, username, avatar_url )`)
    .eq('to_id', user.id)
    .eq('status', 'pending');
  if (error) throw error;
  return data;
}

async function removeFriend(friendRowId) {
  const { error } = await sb.from('friends').delete().eq('id', friendRowId);
  if (error) throw error;
}
