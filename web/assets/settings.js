import { get, write, setPreview } from './api.js';
import { $, el, pad, dimOf, tagKinds, tagKind, periodText, lockIcon } from './dom.js';

const visibility = [['public', '공개'], ['owner', '나만'], ['hidden', '숨김']];

export function createSettings(ctx, { navigate, onClose, onPreview, refreshData }) {
  const dialog = $('settings'), tagForm = $('tagForm'), topicForm = $('topicForm');
  let editingTopic = null, editingTag = null;
  let searchPresets = [], searchPresetError = null;

  function estimateText() {
    const value = ctx.meta.rescore_estimate;
    return `전체 트윗 ${value.tweets.toLocaleString('ko-KR')}개를 이 주제로 다시 채점합니다. 예상 $${value.est_usd}, 약 ${value.est_minutes}분.`;
  }

  function confirmBox(title, message, buttonText) {
    const box = $('confirmDlg');
    $('cfTitle').textContent = title; $('cfMsg').textContent = message; $('cfOk').textContent = buttonText;
    box.returnValue = '';
    return new Promise(resolve => {
      box.addEventListener('close', () => resolve(box.returnValue === 'ok'), { once: true });
      box.showModal(); $('cfNo').focus();
    });
  }
  $('cfOk').addEventListener('click', () => $('confirmDlg').close('ok'));
  $('cfNo').addEventListener('click', () => $('confirmDlg').close('cancel'));

  function setSection(section) {
    $('stTopics').setAttribute('aria-pressed', String(section === 'topics'));
    $('stTags').setAttribute('aria-pressed', String(section === 'tags'));
    $('stSearchPresets').setAttribute('aria-pressed', String(section === 'searchPresets'));
    $('secTopics').hidden = section !== 'topics'; $('secTags').hidden = section !== 'tags';
    $('secSearchPresets').hidden = section !== 'searchPresets';
  }

  function segmented(label, selected, onPick) {
    const row = el('div', 'vis-row'); row.append(el('span', 'fl', label));
    const choices = el('div', 'seg'); choices.setAttribute('role', 'radiogroup'); choices.setAttribute('aria-label', label);
    visibility.forEach(([value, text]) => {
      const button = el('button', 'seg-b'); button.type = 'button'; button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(selected === value));
      if (value === 'owner') button.append(lockIcon());
      button.append(text); button.addEventListener('click', () => onPick(value)); choices.append(button);
    });
    row.append(choices); return row;
  }

  async function patchTopic(topic, change) {
    await write('PATCH', `/api/topics/${encodeURIComponent(topic.id)}`, change);
    await refreshData(); renderTopics();
  }

  function renderTopics() {
    const fragment = document.createDocumentFragment();
    ctx.meta.topics.forEach(topic => {
      const row = el('li', 'toprow');
      const head = el('div', 'top-h'), swatch = el('i'); swatch.style.setProperty('--k', topic.color);
      head.append(swatch, el('b', null, topic.label));
      if (topic.timeline_visibility === 'owner' || topic.search_visibility === 'owner') {
        const icon = lockIcon(); icon.classList.add('lock'); head.append(icon);
      }
      const actions = el('div', 'acts');
      const edit = el('button', null, '수정'); edit.type = 'button'; edit.setAttribute('aria-label', `${topic.label} 주제 수정`);
      edit.addEventListener('click', () => openTopicForm(topic));
      const remove = el('button', null, '삭제'); remove.type = 'button'; remove.setAttribute('aria-label', `${topic.label} 주제 삭제`);
      remove.addEventListener('click', async () => {
        if (!await confirmBox(`‘${topic.label}’ 주제를 지울까요?`, '연표, 검색, 필터에서 빠집니다. 트윗은 그대로 남습니다.', '지우기')) return;
        await write('DELETE', `/api/topics/${encodeURIComponent(topic.id)}`);
        await refreshData(); renderTopics();
      });
      actions.append(edit, remove); head.append(actions); row.append(head);
      row.append(el('p', 'prompt', topic.question || ''));
      if (topic.public_hide_threshold !== undefined && topic.public_hide_threshold !== null) {
        row.append(el('p', 'hide-threshold', `공개 버전 숨김 점수 ${topic.public_hide_threshold}`));
      }
      row.append(segmented('연표', topic.timeline_visibility, value => patchTopic(topic, { timeline_visibility: value })));
      row.append(segmented('검색', topic.search_visibility, value => patchTopic(topic, { search_visibility: value })));
      const scored = topic.scored || 0, total = ctx.meta.total_tweets;
      row.append(el('p', `st${scored < total ? ' wait' : ''}`, `채점 ${scored >= total ? '완료' : '대기'} ${scored}/${total}`));
      fragment.append(row);
    });
    $('topicList').replaceChildren(fragment);
    $('stTopicsN').textContent = ctx.meta.topics.length;
    $('hiddenCount').textContent = ctx.meta.public_hidden_count.toLocaleString('ko-KR');
  }

  function openTopicForm(topic) {
    editingTopic = topic?.id || null;
    $('tpTitle').textContent = topic ? '주제 수정' : '새 주제';
    $('tpName').value = topic?.label || ''; $('tpPrompt').value = topic?.question || '';
    $('tpHide').value = topic?.public_hide_threshold ?? '';
    $('tpErr').hidden = true; topicForm.hidden = false;
    requestAnimationFrame(() => { topicForm.scrollIntoView({ block: 'start' }); $('tpName').focus({ preventScroll: true }); });
  }
  function closeTopicForm() { topicForm.hidden = true; editingTopic = null; }
  $('topicAdd').addEventListener('click', () => openTopicForm(null));
  $('tpCancel').addEventListener('click', closeTopicForm);
  topicForm.addEventListener('submit', async event => {
    event.preventDefault();
    const label = $('tpName').value.trim(), question = $('tpPrompt').value.trim();
    const fail = message => { $('tpErr').textContent = message; $('tpErr').hidden = false; };
    if (!label || !question) { fail('이름과 문구를 모두 적어 주세요.'); return; }
    const rawHide = $('tpHide').value.trim();
    const public_hide_threshold = rawHide === '' ? null : Number(rawHide);
    if (public_hide_threshold !== null
      && (!Number.isFinite(public_hide_threshold) || public_hide_threshold < 0 || public_hide_threshold > 1)) {
      fail('공개 숨김 점수는 비우거나 0부터 1 사이로 입력해 주세요.'); return;
    }
    const previous = ctx.meta.topics.find(topic => topic.id === editingTopic);
    if (!previous) {
      if (!await confirmBox(`‘${label}’ 주제를 추가할까요?`, estimateText(), '추가하고 채점')) return;
      await write('POST', '/api/topics', { label, question, timeline_visibility: 'public', search_visibility: 'public', public_hide_threshold });
    } else {
      if (question !== previous.question && !await confirmBox(`‘${label}’ 문구를 바꿀까요?`, estimateText(), '바꾸고 다시 채점')) return;
      await write('PATCH', `/api/topics/${encodeURIComponent(previous.id)}`, { label, question, public_hide_threshold });
    }
    closeTopicForm(); await refreshData(); renderTopics();
  });

  tagKinds.forEach(([kind, label, color], index) => {
    const row = el('label'), input = el('input'); input.type = 'radio'; input.name = 'kind'; input.value = kind; input.checked = index === 0;
    const view = el('span'), swatch = el('i'); swatch.style.setProperty('--k', color);
    view.append(swatch, label); row.append(input, view); $('fKindsSet').append(row);
  });

  function renderTags() {
    const fragment = document.createDocumentFragment();
    if (!ctx.tags.length) fragment.append(el('p', 'set-note', '태그가 없습니다. 태그 추가로 만들어 보세요.'));
    tagKinds.forEach(([kind, label, color]) => {
      const list = ctx.tags.filter(tag => tag.kind === kind).sort((a, b) => a.start_date.localeCompare(b.start_date));
      if (!list.length) return;
      const section = el('section', 'tgroup'), heading = el('h4'), swatch = el('i'); swatch.style.setProperty('--k', color);
      heading.append(swatch, label, el('span', null, `${list.length}개`)); section.append(heading);
      const ul = el('ul', 'trows');
      list.forEach(tag => {
        const row = el('li', 'trow'), line = el('i'); line.style.setProperty('--k', color); row.append(line);
        const info = el('div'); info.append(el('b', null, tag.label));
        const vis = el('button', `visb${tag.visibility === 'owner' ? ' mine' : ''}`); vis.type = 'button';
        if (tag.visibility === 'owner') vis.append(lockIcon());
        vis.append(tag.visibility === 'owner' ? '나만' : '공개');
        vis.setAttribute('aria-label', `${tag.label} 공개 여부 변경`);
        vis.addEventListener('click', async () => {
          await write('PATCH', `/api/tags/${encodeURIComponent(tag.id)}`, { visibility: tag.visibility === 'owner' ? 'public' : 'owner' });
          await refreshData(); renderTags();
        });
        info.append(vis, el('span', 'per', periodText(tag))); row.append(info);
        const actions = el('div', 'acts');
        const edit = el('button', null, '수정'); edit.type = 'button'; edit.setAttribute('aria-label', `${tag.label} 수정`);
        edit.addEventListener('click', () => openTagForm(tag));
        const remove = el('button', null, '삭제'); remove.type = 'button'; remove.setAttribute('aria-label', `${tag.label} 삭제`);
        remove.addEventListener('click', async () => {
          if (!remove.classList.contains('armed')) { remove.classList.add('armed'); remove.textContent = '정말 삭제'; return; }
          await write('DELETE', `/api/tags/${encodeURIComponent(tag.id)}`);
          await refreshData(); renderTags();
        });
        actions.append(edit, remove); row.append(actions); ul.append(row);
      });
      section.append(ul); fragment.append(section);
    });
    $('tagList').replaceChildren(fragment);
    $('stTagsN').textContent = ctx.tags.length;
  }

  function renderSearchPresets() {
    const list = $('searchPresetList');
    if (!searchPresets.length) {
      const empty = el('li', 'preset-empty', '등록된 공개 검색 문구가 없습니다.');
      list.replaceChildren(empty);
    } else {
      list.replaceChildren(...searchPresets.map((preset, index) => {
        const row = el('li', 'search-preset-row');
        const fields = el('div', 'search-preset-fields');
        const labelField = el('label'), labelText = el('span', 'fl', '표시 이름'), labelInput = el('input');
        labelInput.type = 'text'; labelInput.maxLength = 40; labelInput.value = preset.label;
        labelInput.className = 'preset-label'; labelInput.setAttribute('aria-label', `${index + 1}번째 검색 문구 표시 이름`);
        labelInput.addEventListener('input', () => { preset.label = labelInput.value; searchPresetError = null; renderPresetError(); });
        labelField.append(labelText, labelInput);
        const queryField = el('label'), queryText = el('span', 'fl', '검색 문구'), queryInput = el('textarea');
        queryInput.rows = 2; queryInput.maxLength = 200; queryInput.value = preset.query;
        queryInput.setAttribute('aria-label', `${index + 1}번째 검색 문구 내용`);
        queryInput.addEventListener('input', () => { preset.query = queryInput.value; searchPresetError = null; renderPresetError(); });
        queryField.append(queryText, queryInput);
        fields.append(labelField, queryField);

        const actions = el('div', 'search-preset-actions');
        const moveUp = el('button', null, '위로'); moveUp.type = 'button'; moveUp.disabled = index === 0;
        moveUp.setAttribute('aria-label', `${index + 1}번째 검색 문구 위로 이동`);
        moveUp.addEventListener('click', () => moveSearchPreset(index, -1));
        const moveDown = el('button', null, '아래로'); moveDown.type = 'button'; moveDown.disabled = index === searchPresets.length - 1;
        moveDown.setAttribute('aria-label', `${index + 1}번째 검색 문구 아래로 이동`);
        moveDown.addEventListener('click', () => moveSearchPreset(index, 1));
        const remove = el('button', null, '삭제'); remove.type = 'button';
        remove.setAttribute('aria-label', `${index + 1}번째 검색 문구 삭제`);
        remove.addEventListener('click', () => { searchPresets.splice(index, 1); searchPresetError = null; renderSearchPresets(); });
        actions.append(moveUp, moveDown, remove);
        row.append(fields, actions);
        return row;
      }));
    }
    $('searchPresetAdd').disabled = searchPresets.length >= 20;
    renderPresetError();
  }

  function renderPresetError() {
    const error = $('searchPresetErr'); error.textContent = searchPresetError || ''; error.hidden = !searchPresetError;
  }

  function moveSearchPreset(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= searchPresets.length) return;
    [searchPresets[index], searchPresets[target]] = [searchPresets[target], searchPresets[index]];
    searchPresetError = null;
    renderSearchPresets();
  }

  async function loadSearchPresets() {
    try {
      const response = await get('/api/search/presets');
      searchPresets = response.presets;
      searchPresetError = null;
    } catch (error) {
      searchPresetError = `검색 문구를 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
    }
    renderSearchPresets();
  }

  $('searchPresetAdd').addEventListener('click', () => {
    if (searchPresets.length >= 20) return;
    searchPresets.push({ label: '', query: '' });
    searchPresetError = null;
    renderSearchPresets();
    requestAnimationFrame(() => {
      const inputs = $('searchPresetList').querySelectorAll('.preset-label');
      inputs[inputs.length - 1]?.focus();
    });
  });
  $('searchPresetSave').addEventListener('click', async () => {
    if (searchPresets.some(({ label, query }) => !label.trim() || label.length > 40 || !query.trim() || query.length > 200)) {
      searchPresetError = '표시 이름은 1~40자, 검색 문구는 1~200자로 입력해 주세요.';
      renderPresetError(); return;
    }
    try {
      const response = await write('PUT', '/api/search/presets', {
        presets: searchPresets.map(({ label, query }) => ({ label, query })),
      });
      searchPresets = response.presets;
      searchPresetError = null;
      renderSearchPresets();
    } catch (error) {
      searchPresetError = error instanceof Error ? error.message : String(error);
      renderPresetError();
    }
  });

  function openTagForm(tag) {
    editingTag = tag?.id || null;
    $('tfTitle').textContent = tag ? '태그 수정' : '새 태그';
    $('fName').value = tag?.label || '';
    tagForm.querySelectorAll('input[name="kind"]').forEach(input => { input.checked = input.value === (tag?.kind || 'career'); });
    $('fStartM').value = tag?.start_date.slice(0, 7) || '';
    $('fStartD').value = tag ? String(+tag.start_date.slice(8, 10)) : '';
    $('fEndM').value = tag?.end_date?.slice(0, 7) || '';
    $('fEndD').value = tag?.end_date ? String(+tag.end_date.slice(8, 10)) : '';
    $('fOngoing').checked = !!tag && !tag.end_date; syncOngoing();
    $('fMemo').value = tag?.note || '';
    tagForm.querySelectorAll('input[name="tvis"]').forEach(input => { input.checked = input.value === (tag?.visibility || 'public'); });
    $('fErr').hidden = true; tagForm.hidden = false;
    requestAnimationFrame(() => { tagForm.scrollIntoView({ block: 'start' }); $('fName').focus({ preventScroll: true }); });
  }
  function closeTagForm() { editingTag = null; tagForm.hidden = true; }
  function syncOngoing() { $('fEndM').disabled = $('fEndD').disabled = $('fOngoing').checked; }
  function readDate(monthId, dayId, isEnd) {
    const month = $(monthId).value, day = $(dayId).value;
    if (!/^\d{4}-\d{2}$/.test(month)) return null;
    const [year, number] = month.split('-').map(Number);
    const max = dimOf(year, number);
    const value = day ? +day : isEnd ? max : 1;
    return value >= 1 && value <= max ? `${month}-${pad(value)}` : null;
  }
  $('fOngoing').addEventListener('change', syncOngoing);
  $('tagAdd').addEventListener('click', () => openTagForm(null));
  $('fCancel').addEventListener('click', closeTagForm);
  tagForm.addEventListener('submit', async event => {
    event.preventDefault();
    const fail = message => { $('fErr').textContent = message; $('fErr').hidden = false; };
    const label = $('fName').value.trim(); if (!label) { fail('이름을 적어 주세요.'); return; }
    const start_date = readDate('fStartM', 'fStartD', false);
    const end_date = $('fOngoing').checked ? null : readDate('fEndM', 'fEndD', true);
    if (!start_date || (!end_date && !$('fOngoing').checked)) { fail('시작과 끝 날짜를 확인해 주세요.'); return; }
    if (end_date && end_date < start_date) { fail('끝이 시작보다 앞섭니다.'); return; }
    const input = { label, kind: tagForm.querySelector('input[name="kind"]:checked').value,
      start_date, end_date, note: $('fMemo').value.trim() || null,
      visibility: tagForm.querySelector('input[name="tvis"]:checked').value };
    if (editingTag) await write('PATCH', `/api/tags/${encodeURIComponent(editingTag)}`, input);
    else await write('POST', '/api/tags', input);
    closeTagForm(); await refreshData(); renderTags();
  });

  async function open(editTagId = null, route = true) {
    if (!ctx.owner || ctx.preview) return;
    renderTopics(); renderTags(); renderSearchPresets();
    if (editTagId) { setSection('tags'); openTagForm(ctx.tags.find(tag => tag.id === editTagId)); }
    else { setSection('topics'); closeTopicForm(); closeTagForm(); }
    if (route) navigate('/settings');
    if (!dialog.open) dialog.showModal();
    void loadSearchPresets();
  }
  function close() { if (dialog.open) dialog.close(); onClose(); }
  $('setBtn').addEventListener('click', () => open());
  $('setClose').addEventListener('click', close);
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  $('stTopics').addEventListener('click', () => setSection('topics'));
  $('stTags').addEventListener('click', () => setSection('tags'));
  $('stSearchPresets').addEventListener('click', () => setSection('searchPresets'));
  $('visSwitch').addEventListener('click', async () => {
    setPreview(true); dialog.close(); await onPreview();
  });
  $('visOff').addEventListener('click', async () => { setPreview(false); await onPreview(); });
  return { open, close, isOpen: () => dialog.open, refresh() { if (dialog.open) { renderTopics(); renderTags(); } } };
}
