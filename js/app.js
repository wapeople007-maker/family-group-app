import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import {
  createScheduleMapPicker,
  getDirectionsUrl,
  isKakaoMapConfigured,
  loadKakaoMapSDK,
  renderMiniMap,
} from './kakao-map.js';

function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL)
    && Boolean(SUPABASE_ANON_KEY)
    && !SUPABASE_URL.includes('YOUR_SUPABASE')
    && !SUPABASE_ANON_KEY.includes('YOUR_SUPABASE');
}

const supabase = isSupabaseConfigured()
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  group: null,
  members: [],
  realtimeChannel: null,
  scheduleMapPicker: null,
};

const AUTH_EMAIL_DOMAIN = 'family-group.local';

function toAuthEmail(username) {
  const id = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (id.length < 2) {
    throw new Error('아이디는 영문·숫자·밑줄(_) 2자 이상으로 입력하세요.');
  }
  return `${id}@${AUTH_EMAIL_DOMAIN}`;
}

function setButtonLoading(button, isLoading, loadingText) {
  if (!button) return;
  button.disabled = isLoading;
  if (!button.dataset.defaultText) {
    button.dataset.defaultText = button.textContent;
  }
  button.textContent = isLoading ? loadingText : button.dataset.defaultText;
}
function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function showScreen(name) {
  ['auth-screen', 'group-screen', 'app-screen'].forEach((id) => {
    $(id).classList.toggle('hidden', id !== name);
  });
}

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  state.user = data.session?.user ?? null;
  return state.user;
}

async function ensureProfile(displayName) {
  if (!supabase || !state.user) return;

  const name = displayName
    || state.user.user_metadata?.display_name
    || state.user.email?.split('@')[0]
    || '회원';

  await supabase.from('profiles').upsert(
    { id: state.user.id, display_name: name },
    { onConflict: 'id' }
  );
}

async function refreshGroupContext() {
  if (!state.group || !supabase) return null;

  const { data: members, error } = await supabase
    .from('group_members')
    .select('id, role, user_id, profiles(display_name)')
    .eq('group_id', state.group.id);

  if (error) return error.message;

  state.members = members ?? [];
  $('group-name').textContent = state.group.name;
  $('invite-code').textContent = state.group.invite_code;
  return null;
}

async function loadUserGroup() {
  if (!supabase || !state.user) {
    showScreen('auth-screen');
    return false;
  }

  const { data, error } = await supabase
    .from('group_members')
    .select('group_id, groups(id, name, invite_code)')
    .eq('user_id', state.user.id)
    .limit(1)
    .maybeSingle();

  if (error) {
    toast(error.message);
    showScreen('group-screen');
    return false;
  }

  if (data?.groups) {
    state.group = data.groups;
    const contextError = await refreshGroupContext();
    if (contextError) {
      toast(contextError);
      showScreen('group-screen');
      return false;
    }
    showScreen('app-screen');
    await switchTab('home');
    subscribeRealtime();
    return true;
  }

  showScreen('group-screen');
  return false;
}

function subscribeRealtime() {
  if (state.realtimeChannel) {
    supabase.removeChannel(state.realtimeChannel);
  }

  if (!state.group) return;

  state.realtimeChannel = supabase
    .channel(`group-${state.group.id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'schedules', filter: `group_id=eq.${state.group.id}` }, () => loadSchedules())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'todos', filter: `group_id=eq.${state.group.id}` }, () => loadTodos())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'photos', filter: `group_id=eq.${state.group.id}` }, () => loadPhotos())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'expenses', filter: `group_id=eq.${state.group.id}` }, () => loadExpenses())
    .subscribe();
}

async function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  ['home', 'schedules', 'todos', 'album', 'expenses'].forEach((name) => {
    $(`panel-${name}`).classList.toggle('hidden', name !== tab);
  });

  if (tab === 'home') await loadHome();
  if (tab === 'schedules') {
    await initScheduleMapPicker();
    await loadSchedules();
  }
  if (tab === 'todos') await loadTodos();
  if (tab === 'album') await loadPhotos();
  if (tab === 'expenses') await loadExpenses();
}

async function loadHome() {
  const upcoming = await supabase
    .from('schedules')
    .select('*')
    .eq('group_id', state.group.id)
    .gte('start_at', new Date().toISOString())
    .order('start_at', { ascending: true })
    .limit(3);

  const openTodos = await supabase
    .from('todos')
    .select('*')
    .eq('group_id', state.group.id)
    .eq('is_done', false)
    .order('created_at', { ascending: false })
    .limit(5);

  const expenseSum = await supabase
    .from('expenses')
    .select('amount')
    .eq('group_id', state.group.id);

  const total = (expenseSum.data ?? []).reduce((sum, row) => sum + Number(row.amount), 0);

  $('home-stats').innerHTML = `
    <div class="item"><span>멤버</span><strong>${state.members.length}명</strong></div>
    <div class="item"><span>다가오는 일정</span><strong>${upcoming.data?.length ?? 0}건</strong></div>
    <div class="item"><span>남은 할 일</span><strong>${openTodos.data?.length ?? 0}건</strong></div>
    <div class="item"><span>총 회비</span><strong>${total.toLocaleString()}원</strong></div>
  `;

  $('home-upcoming').innerHTML = (upcoming.data ?? [])
    .map((s) => `<div class="item"><h3>${escapeHtml(s.title)}</h3><p>${formatDateTime(s.start_at)}${s.location_name ? ` · ${escapeHtml(s.location_name)}` : ''}</p></div>`)
    .join('') || '<p class="muted">등록된 일정이 없습니다.</p>';
}

async function initScheduleMapPicker() {
  const mapContainer = $('schedule-map-picker');
  const mapHint = $('schedule-map-hint');

  if (!isKakaoMapConfigured()) {
    mapContainer.classList.add('hidden');
    mapHint.classList.add('hidden');
    return;
  }

  if (state.scheduleMapPicker) return;

  try {
    await loadKakaoMapSDK();
    mapContainer.classList.remove('hidden');
    mapHint.classList.remove('hidden');

    state.scheduleMapPicker = createScheduleMapPicker(mapContainer, {
      onSelect: (location) => {
        $('schedule-location').value = location.name;
        $('schedule-lat').value = location.lat;
        $('schedule-lng').value = location.lng;
      },
    });
  } catch (error) {
    toast(error.message);
  }
}

function resetScheduleLocationFields() {
  $('schedule-location').value = '';
  $('schedule-lat').value = '';
  $('schedule-lng').value = '';
  $('schedule-search-results').classList.add('hidden');
  $('schedule-search-results').innerHTML = '';
  state.scheduleMapPicker?.reset();
}

async function loadSchedules() {
  const { data, error } = await supabase
    .from('schedules')
    .select('*')
    .eq('group_id', state.group.id)
    .order('start_at', { ascending: true });

  if (error) return toast(error.message);

  $('schedule-list').innerHTML = (data ?? [])
    .map((s) => {
      const hasCoords = s.location_lat && s.location_lng;
      const mapLink = hasCoords
        ? `<a class="link-btn" href="${getDirectionsUrl(s.location_name, s.location_lat, s.location_lng)}" target="_blank" rel="noopener">길찾기</a>`
        : '';
      const mapBlock = hasCoords
        ? `<div class="mini-map" data-mini-map data-lat="${s.location_lat}" data-lng="${s.location_lng}" data-title="${escapeHtml(s.location_name || s.title)}"></div>`
        : '';

      return `
        <div class="item">
          <h3>${escapeHtml(s.title)}</h3>
          <p>${formatDateTime(s.start_at)}${s.location_name ? ` · ${escapeHtml(s.location_name)}` : ''}</p>
          ${s.description ? `<p>${escapeHtml(s.description)}</p>` : ''}
          ${mapBlock}
          <div class="row">${mapLink}<button class="btn-danger" data-delete-schedule="${s.id}">삭제</button></div>
        </div>`;
    })
    .join('') || '<p class="muted">일정을 추가해 보세요.</p>';

  if (isKakaoMapConfigured() && (data ?? []).some((s) => s.location_lat && s.location_lng)) {
    try {
      await loadKakaoMapSDK();
      document.querySelectorAll('[data-mini-map]').forEach((el) => {
        renderMiniMap(el, {
          lat: Number(el.dataset.lat),
          lng: Number(el.dataset.lng),
          title: el.dataset.title,
        });
      });
    } catch (error) {
      toast(error.message);
    }
  }
}

async function loadTodos() {
  const { data, error } = await supabase
    .from('todos')
    .select('*')
    .eq('group_id', state.group.id)
    .order('created_at', { ascending: false });

  if (error) return toast(error.message);

  $('todo-list').innerHTML = (data ?? [])
    .map((t) => `
      <div class="item ${t.is_done ? 'done' : ''}">
        <div class="row">
          <input type="checkbox" data-toggle-todo="${t.id}" ${t.is_done ? 'checked' : ''} />
          <h3>${escapeHtml(t.title)}</h3>
        </div>
        <button class="btn-danger" data-delete-todo="${t.id}">삭제</button>
      </div>`)
    .join('') || '<p class="muted">할 일을 추가해 보세요.</p>';
}

async function loadPhotos() {
  const { data, error } = await supabase
    .from('photos')
    .select('*')
    .eq('group_id', state.group.id)
    .order('created_at', { ascending: false });

  if (error) return toast(error.message);

  $('photo-grid').innerHTML = await Promise.all(
    (data ?? []).map(async (photo) => {
      const { data: urlData } = supabase.storage.from('photos').getPublicUrl(photo.storage_path);
      return `
        <figure>
          <img src="${urlData.publicUrl}" alt="${escapeHtml(photo.caption || '사진')}" loading="lazy" />
          ${photo.caption ? `<figcaption>${escapeHtml(photo.caption)}</figcaption>` : ''}
        </figure>`;
    })
  ).then((items) => items.join('')) || '<p class="muted">첫 추억 사진을 올려보세요.</p>';
}

async function loadExpenses() {
  const { data, error } = await supabase
    .from('expenses')
    .select('*, profiles!expenses_paid_by_fkey(display_name)')
    .eq('group_id', state.group.id)
    .order('expense_date', { ascending: false });

  if (error) return toast(error.message);

  const total = (data ?? []).reduce((sum, row) => sum + Number(row.amount), 0);
  const perPerson = state.members.length ? Math.round(total / state.members.length) : 0;

  $('expense-summary').innerHTML = `
    <div class="item"><span>총 지출</span><strong>${total.toLocaleString()}원</strong></div>
    <div class="item"><span>1인당(참고)</span><strong>${perPerson.toLocaleString()}원</strong></div>
  `;

  $('expense-list').innerHTML = (data ?? [])
    .map((e) => `
      <div class="item">
        <h3>${escapeHtml(e.title)} · ${Number(e.amount).toLocaleString()}원</h3>
        <p>${e.expense_date} · ${escapeHtml(e.profiles?.display_name || '미정')}</p>
        ${e.note ? `<p>${escapeHtml(e.note)}</p>` : ''}
        <button class="btn-danger" data-delete-expense="${e.id}">삭제</button>
      </div>`)
    .join('') || '<p class="muted">회비 내역을 추가해 보세요.</p>';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDateTime(value) {
  return new Date(value).toLocaleString('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Auth handlers
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!supabase) return toast('Supabase 설정이 필요합니다. js/config.js를 확인하세요.');

  const submitBtn = $('login-submit');
  setButtonLoading(submitBtn, true, '로그인 중...');

  try {
    const username = $('login-username').value.trim();
    const password = $('login-password').value;
    const email = toAuthEmail(username);

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return toast(translateAuthError(error.message));

    state.user = (await supabase.auth.getUser()).data.user;
    await ensureProfile(displayName);
    toast('로그인되었습니다.');
    await loadUserGroup();
  } catch (error) {
    toast(error.message);
  } finally {
    setButtonLoading(submitBtn, false);
  }
});

$('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!supabase) return toast('Supabase 설정이 필요합니다. js/config.js를 확인하세요.');

  const submitBtn = $('signup-submit');
  setButtonLoading(submitBtn, true, '가입 중...');

  try {
    const username = $('signup-username').value.trim();
    const password = $('signup-password').value;
    const displayName = $('signup-name').value.trim();
    const email = toAuthEmail(username);

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName } },
    });

    if (error) return toast(translateAuthError(error.message));

    if (data.session) {
      state.user = data.user;
      await ensureProfile(displayName);
      toast('가입 완료! 바로 이용할 수 있습니다.');
      await loadUserGroup();
      return;
    }

    const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });
    if (loginError) {
      return toast('가입은 됐지만 바로 로그인이 안 됩니다. Supabase에서 이메일 인증을 끄거나 잠시 후 다시 로그인하세요.');
    }

    state.user = (await supabase.auth.getUser()).data.user;
    await ensureProfile(displayName);
    toast('가입 완료! 로그인되었습니다.');
    await loadUserGroup();
  } catch (error) {
    toast(error.message);
  } finally {
    setButtonLoading(submitBtn, false);
  }
});

function translateAuthError(message) {
  if (message.includes('Invalid login credentials')) return '아이디 또는 비밀번호가 맞지 않습니다.';
  if (message.includes('User already registered')) return '이미 사용 중인 아이디입니다.';
  if (message.includes('Email not confirmed')) return '계정 확인이 필요합니다. Supabase에서 이메일 인증을 꺼 주세요.';
  return message;
}

$('logout-btn').addEventListener('click', async () => {
  await supabase.auth.signOut();
  state.user = null;
  state.group = null;
  if (state.realtimeChannel) supabase.removeChannel(state.realtimeChannel);
  showScreen('auth-screen');
});

// Group handlers
$('create-group-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = $('create-group-submit');
  setButtonLoading(submitBtn, true, '생성 중...');

  try {
    if (!supabase) {
      toast('Supabase 연결이 필요합니다.');
      return;
    }
    if (!state.user) {
      toast('로그인이 필요합니다. 다시 로그인해 주세요.');
      showScreen('auth-screen');
      return;
    }

    const name = $('create-group-name').value.trim();
    if (!name) {
      toast('모임 이름을 입력하세요.');
      return;
    }

    const inviteCode = generateInviteCode();

    const { data: group, error: groupError } = await supabase
      .from('groups')
      .insert({ name, invite_code: inviteCode, created_by: state.user.id })
      .select('id, name, invite_code')
      .single();

    if (groupError) {
      toast(`모임 생성 실패: ${groupError.message}`);
      return;
    }

    const { error: memberError } = await supabase.from('group_members').insert({
      group_id: group.id,
      user_id: state.user.id,
      role: 'admin',
    });

    if (memberError) {
      toast(`멤버 등록 실패: ${memberError.message}`);
      return;
    }

    state.group = group;
    const contextError = await refreshGroupContext();
    if (contextError) {
      toast(contextError);
      return;
    }

    showScreen('app-screen');
    subscribeRealtime();
    toast(`모임이 생성되었습니다! 초대 코드: ${inviteCode}`);
    $('create-group-name').value = '';
    await switchTab('home');
  } catch (error) {
    toast(error.message || '모임 생성 중 오류가 발생했습니다.');
  } finally {
    setButtonLoading(submitBtn, false);
  }
});

$('join-group-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = $('join-group-submit');
  setButtonLoading(submitBtn, true, '참여 중...');

  try {
    if (!supabase) {
      toast('Supabase 연결이 필요합니다.');
      return;
    }
    if (!state.user) {
      toast('로그인이 필요합니다. 다시 로그인해 주세요.');
      showScreen('auth-screen');
      return;
    }

    const code = $('join-group-code').value.trim().toUpperCase();
    if (!code) {
      toast('초대 코드를 입력하세요.');
      return;
    }

    const { data: group, error: findError } = await supabase
      .from('groups')
      .select('id, name, invite_code')
      .eq('invite_code', code)
      .maybeSingle();

    if (findError) {
      toast(findError.message);
      return;
    }
    if (!group) {
      toast('초대 코드를 찾을 수 없습니다.');
      return;
    }

    const { error: joinError } = await supabase.from('group_members').insert({
      group_id: group.id,
      user_id: state.user.id,
      role: 'member',
    });

    if (joinError) {
      if (joinError.code === '23505') {
        toast('이미 가입한 모임입니다.');
      } else {
        toast(joinError.message);
      }
      return;
    }

    state.group = group;
    const contextError = await refreshGroupContext();
    if (contextError) {
      toast(contextError);
      return;
    }

    showScreen('app-screen');
    subscribeRealtime();
    toast('모임에 참여했습니다!');
    await switchTab('home');
  } catch (error) {
    toast(error.message || '모임 참여 중 오류가 발생했습니다.');
  } finally {
    setButtonLoading(submitBtn, false);
  }
});

// Tab navigation
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// Create forms
$('schedule-search-btn').addEventListener('click', async () => {
  if (!state.scheduleMapPicker) {
    await initScheduleMapPicker();
  }
  if (!state.scheduleMapPicker) return;

  const keyword = $('schedule-location').value.trim();
  if (!keyword) return toast('검색할 장소를 입력하세요.');

  const results = await state.scheduleMapPicker.search(keyword);
  const list = $('schedule-search-results');

  if (!results.length) {
    list.innerHTML = '<li class="search-empty">검색 결과가 없습니다.</li>';
    list.classList.remove('hidden');
    return;
  }

  list.innerHTML = results
    .slice(0, 5)
    .map((place, index) => `
      <li>
        <button type="button" class="search-result-btn" data-search-index="${index}">
          <strong>${escapeHtml(place.place_name)}</strong>
          <span>${escapeHtml(place.road_address_name || place.address_name || '')}</span>
        </button>
      </li>`)
    .join('');
  list.classList.remove('hidden');
  list.dataset.results = JSON.stringify(results.slice(0, 5));
});

$('schedule-search-results').addEventListener('click', (e) => {
  const button = e.target.closest('[data-search-index]');
  if (!button || !state.scheduleMapPicker) return;

  const results = JSON.parse($('schedule-search-results').dataset.results || '[]');
  const place = results[Number(button.dataset.searchIndex)];
  if (!place) return;

  state.scheduleMapPicker.selectSearchResult(place);
  $('schedule-search-results').classList.add('hidden');
});

$('schedule-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('schedule-title').value.trim();
  const startAt = $('schedule-start').value;
  const locationName = $('schedule-location').value.trim();
  const locationLat = $('schedule-lat').value ? Number($('schedule-lat').value) : null;
  const locationLng = $('schedule-lng').value ? Number($('schedule-lng').value) : null;

  const { error } = await supabase.from('schedules').insert({
    group_id: state.group.id,
    title,
    start_at: new Date(startAt).toISOString(),
    location_name: locationName || null,
    location_lat: locationLat,
    location_lng: locationLng,
    created_by: state.user.id,
  });

  if (error) return toast(error.message);
  e.target.reset();
  resetScheduleLocationFields();
  toast('일정이 추가되었습니다.');
  await loadSchedules();
});

$('todo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('todo-title').value.trim();

  const { error } = await supabase.from('todos').insert({
    group_id: state.group.id,
    title,
    created_by: state.user.id,
  });

  if (error) return toast(error.message);
  e.target.reset();
  toast('할 일이 추가되었습니다.');
  await loadTodos();
});

$('photo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('photo-file').files[0];
  const caption = $('photo-caption').value.trim();
  if (!file) return toast('사진 파일을 선택하세요.');

  const ext = file.name.split('.').pop();
  const path = `${state.group.id}/${crypto.randomUUID()}.${ext}`;

  const { error: uploadError } = await supabase.storage.from('photos').upload(path, file);
  if (uploadError) return toast(uploadError.message);

  const { error } = await supabase.from('photos').insert({
    group_id: state.group.id,
    storage_path: path,
    caption: caption || null,
    uploaded_by: state.user.id,
  });

  if (error) return toast(error.message);
  e.target.reset();
  toast('사진이 업로드되었습니다.');
  await loadPhotos();
});

$('expense-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('expense-title').value.trim();
  const amount = Number($('expense-amount').value);
  const note = $('expense-note').value.trim();

  const { error } = await supabase.from('expenses').insert({
    group_id: state.group.id,
    title,
    amount,
    note: note || null,
    paid_by: state.user.id,
    created_by: state.user.id,
  });

  if (error) return toast(error.message);
  e.target.reset();
  toast('회비 내역이 추가되었습니다.');
  await loadExpenses();
});

// Delegated actions
document.body.addEventListener('click', async (e) => {
  const scheduleId = e.target.dataset.deleteSchedule;
  if (scheduleId) {
    await supabase.from('schedules').delete().eq('id', scheduleId);
    await loadSchedules();
  }

  const todoId = e.target.dataset.deleteTodo;
  if (todoId) {
    await supabase.from('todos').delete().eq('id', todoId);
    await loadTodos();
  }

  const expenseId = e.target.dataset.deleteExpense;
  if (expenseId) {
    await supabase.from('expenses').delete().eq('id', expenseId);
    await loadExpenses();
  }
});

document.body.addEventListener('change', async (e) => {
  const todoId = e.target.dataset.toggleTodo;
  if (todoId) {
    await supabase.from('todos').update({ is_done: e.target.checked }).eq('id', todoId);
    await loadTodos();
  }
});

// Boot
(async function init() {
  if (!isSupabaseConfigured()) {
    toast('js/config.js에 Supabase URL과 anon key를 입력하세요.');
  }

  if (!isKakaoMapConfigured()) {
    toast('js/config.js에 카카오 JavaScript 키를 입력하면 지도 기능이 활성화됩니다.');
  }

  if (!supabase) {
    showScreen('auth-screen');
    return;
  }

  await getSession();
  if (state.user) {
    await loadUserGroup();
  } else {
    showScreen('auth-screen');
  }

  supabase.auth.onAuthStateChange(async (_event, session) => {
    state.user = session?.user ?? null;
    if (!state.user) showScreen('auth-screen');
  });
})();
