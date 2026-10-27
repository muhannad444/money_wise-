// ---------- Storage ----------
var STORAGE_KEY = 'mw_state_v2';
var OLD_INCOME_KEY = 'mw_income';

var state = {
  income: 0,
  splitMode: 'default', // 'default' (fixed 50/30/20) or 'priority' (set by the person)
  priorities: { needs: 3, wants: 2, savings: 1 }, // used only when splitMode === 'priority'
  // Needs & Savings items: {id, name, amount}
  // Wants items: {id, name, costPerTime, timesPerMonth, amount} where amount = costPerTime * timesPerMonth
  items: { needs: [], wants: [], savings: [] },
  // Items also carry spends: [{id, name, amount, date}] — what was actually spent (or put aside).
  grow: { budget: null, time: null, interest: null, risk: null, level: null },
  steps: {} // first-step checklist progress per opportunity: { id: [true,false,...] }
};

// Tracks the id of an item that was just added, purely so its <li> can play a
// one-time entrance animation. Cleared right after that render, so it never
// re-triggers on unrelated re-renders (deleting, changing income, etc.).
var lastAddedItemId = null;

function saveState(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState(){
  try{
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if(saved && typeof saved === 'object'){
      if(typeof saved.income === 'number' && saved.income > 0) state.income = saved.income;
      if(saved.items) state.items = saved.items;
      if(saved.priorities) state.priorities = saved.priorities;
      if(saved.splitMode) state.splitMode = saved.splitMode;
      if(saved.grow && typeof saved.grow === 'object'){
        ['budget', 'time', 'interest', 'risk', 'level'].forEach(function(k){
          if(saved.grow[k] !== undefined) state.grow[k] = saved.grow[k];
        });
      }
      if(saved.steps && typeof saved.steps === 'object') state.steps = saved.steps;
      // A plan saved by the previous fixed-percentage version has no splitMode
      // field at all, so it naturally falls back to the 'default' 50/30/20 split.
      // Any items saved under the old "by importance" itemizer had a `priority`
      // field instead of `amount`; treat those as unusable and drop them per
      // category, rather than showing broken RM 0 rows.
      ['needs', 'wants', 'savings'].forEach(function(cat){
        state.items[cat] = (state.items[cat] || []).filter(function(item){
          return typeof item.amount === 'number';
        }).map(function(item){
          if(!Array.isArray(item.spends)) item.spends = [];
          return item;
        });
      });
      return;
    }
  } catch(e){ /* fall through to migration */ }

  // Migrate a value saved by an even earlier, simpler version of the site.
  try{
    var oldIncome = JSON.parse(localStorage.getItem(OLD_INCOME_KEY));
    if(typeof oldIncome === 'number' && oldIncome > 0) state.income = oldIncome;
  } catch(e){ /* nothing to migrate */ }
}

// ---------- Calculation helpers ----------
function getSplitPercents(){
  if(state.splitMode === 'priority'){
    var totalPoints = state.priorities.needs + state.priorities.wants + state.priorities.savings;
    if(totalPoints > 0){
      return {
        needs: Math.round(state.priorities.needs / totalPoints * 100),
        wants: Math.round(state.priorities.wants / totalPoints * 100),
        savings: Math.round(state.priorities.savings / totalPoints * 100)
      };
    }
  }
  return { needs: 50, wants: 30, savings: 20 };
}

function calcBudgets(income){
  if(state.splitMode === 'priority'){
    var totalPoints = state.priorities.needs + state.priorities.wants + state.priorities.savings;
    if(totalPoints > 0){
      return {
        needs: income * (state.priorities.needs / totalPoints),
        wants: income * (state.priorities.wants / totalPoints),
        savings: income * (state.priorities.savings / totalPoints)
      };
    }
  }
  return { needs: income * 0.5, wants: income * 0.3, savings: income * 0.2 };
}

function fmt(n){
  var rounded = Math.round((n + Number.EPSILON) * 100) / 100;
  return 'RM ' + rounded.toLocaleString('en-MY', { maximumFractionDigits: 2 });
}

function categoryTotal(cat){
  return state.items[cat].reduce(function(sum, item){ return sum + item.amount; }, 0);
}

// ---------- DOM refs ----------
var incomeInput = document.getElementById('incomeInput');
var incomeError = document.getElementById('incomeError');
var createPlanBtn = document.getElementById('createPlanBtn');
var resultsSection = document.getElementById('results');
var resultsGrid = document.getElementById('resultsGrid');
var welcomeBack = document.getElementById('welcomeBack');
var quickAmounts = document.getElementById('quickAmounts');

var totalMoneyDisplay = document.getElementById('totalMoneyDisplay');
var navbar = document.getElementById('navbar');

var splitCustomizer = document.getElementById('splitCustomizer');
var splitReason = document.getElementById('splitReason');
var resetSplitBtn = document.getElementById('resetSplitBtn');

var copyPlanBtn = document.getElementById('copyPlanBtn');
var printPlanBtn = document.getElementById('printPlanBtn');
var copyFeedback = document.getElementById('copyFeedback');

var categoryLabels = { needs: 'Needs', wants: 'Wants', savings: 'Savings' };

// ---------- Feedback: toasts + inline form errors ----------
var toastWrap = document.getElementById('toastWrap');
var toastTimer = null;

// A short message that confirms an action. Pass { undo: fn } to offer an Undo button,
// or { tone: 'warn' } for something the person should pay attention to.
function showToast(message, opts){
  opts = opts || {};
  toastWrap.innerHTML = '';
  var t = document.createElement('div');
  t.className = 'toast' + (opts.tone ? ' toast-' + opts.tone : '');
  var span = document.createElement('span');
  span.textContent = message;
  t.appendChild(span);
  if(opts.undo){
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-undo';
    b.textContent = 'Undo';
    b.addEventListener('click', function(){
      opts.undo();
      toastWrap.innerHTML = '';
    });
    t.appendChild(b);
  }
  toastWrap.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ toastWrap.innerHTML = ''; }, opts.undo ? 6000 : 3200);
}

function clearErrors(scope){
  scope.querySelectorAll('.has-error').forEach(function(el){ el.classList.remove('has-error'); });
  var m = scope.querySelector('.form-msg');
  if(m){ m.textContent = ''; m.classList.remove('show'); }
}

function flagError(scope, input, msg){
  clearErrors(scope);
  var m = scope.querySelector('.form-msg');
  if(m){ m.textContent = msg; m.classList.add('show'); }
  if(input){
    (input.closest('.wants-field') || input).classList.add('has-error');
    input.focus();
  }
}

// ---------- Plan mode (first visit vs. returning with a plan) ----------
function setPlanMode(){
  var on = state.income > 0;
  document.body.classList.toggle('has-plan', on);
  if(!on) document.body.classList.remove('editing-plan');
  createPlanBtn.textContent = on ? 'Update my plan' : 'Create my plan';
  document.getElementById('calcTitle').textContent = on ? 'Change your amount or priorities' : 'How much money do you have?';
  document.getElementById('leftPill').hidden = !on;
  var fab = document.getElementById('backToCalc');
  if(fab) fab.setAttribute('aria-label', on ? 'Back to my plan' : 'Back to calculator');
}

// One clear thing to do next, based on where the person is.
function renderNextStep(){
  var box = document.getElementById('nextStep');
  if(!box) return;
  var count = 0, logged = 0;
  ['needs', 'wants', 'savings'].forEach(function(c){
    count += state.items[c].length;
    state.items[c].forEach(function(i){ logged += (i.spends || []).length; });
  });
  var left = state.income - categorySpent('needs') - categorySpent('wants') - categorySpent('savings');
  var action, title, desc, label;
  if(count === 0){
    action = 'add';
    title = 'Add your first category';
    desc = 'Split each budget into things you\'ll pay for, like Rent or Food. You set the plan for each one.';
    label = 'Add a category';
  } else if(logged === 0){
    action = 'log';
    title = 'Add your first expense';
    desc = 'When you spend money, tap + Add expense on a category. We work out what\'s left for you.';
    label = 'Add an expense';
  } else if(left < 0){
    action = 'edit';
    title = 'You\'ve logged more than you have';
    desc = 'Check your categories, or change your amount if your income is different this month.';
    label = 'Change amount';
  } else {
    action = 'grow';
    title = 'You have ' + fmt(left) + ' left this month';
    desc = 'Keep adding expenses as you spend. If some of it isn\'t needed right away, see ideas for growing it.';
    label = 'Explore ideas';
  }
  document.getElementById('nextTitle').textContent = title;
  document.getElementById('nextDesc').textContent = desc;
  var btn = document.getElementById('nextAction');
  btn.textContent = label;
  btn.setAttribute('data-action', action);
  box.className = 'next-step next-' + action;
}

// ---------- Render: results cards ----------
function animateCount(el, target, duration){
  var startTime = null;
  function step(ts){
    if(!startTime) startTime = ts;
    var progress = Math.min((ts - startTime) / duration, 1);
    var eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = fmt(target * eased);
    if(progress < 1) requestAnimationFrame(step);
    else el.textContent = fmt(target);
  }
  requestAnimationFrame(step);
}

function renderResults(animate){
  setPlanMode();
  if(state.income <= 0){
    resultsSection.classList.remove('show');
    return;
  }
  var budgets = calcBudgets(state.income);
  var percents = getSplitPercents();
  resultsSection.classList.add('show');
  totalMoneyDisplay.textContent = fmt(state.income);

  document.getElementById('needsPctLabel').textContent = percents.needs + '%';
  document.getElementById('wantsPctLabel').textContent = percents.wants + '%';
  document.getElementById('savingsPctLabel').textContent = percents.savings + '%';


  ['needs', 'wants', 'savings'].forEach(function(cat){ renderItems(cat, true, animate); });
  staggerResultCards();
}

function staggerResultCards(){
  var cards = resultsGrid.querySelectorAll('.result-card');
  cards.forEach(function(card){ card.classList.remove('card-in'); });
  cards.forEach(function(card, i){
    setTimeout(function(){ card.classList.add('card-in'); }, i * 130);
  });
}

// ---------- Spending helpers ----------
var openLogs = {}; // which item "log spending" panels are open, so re-renders don't close them

function itemSpent(item){
  return (item.spends || []).reduce(function(sum, s){ return sum + s.amount; }, 0);
}

function categorySpent(cat){
  return state.items[cat].reduce(function(sum, item){ return sum + itemSpent(item); }, 0);
}

function findItem(cat, id){
  var list = state.items[cat];
  for(var i = 0; i < list.length; i++){
    if(String(list[i].id) === String(id)) return list[i];
  }
  return null;
}

function progressClass(spent, plan, cat){
  if(plan <= 0) return '';
  var ratio = spent / plan;
  if(cat === 'savings') return ratio >= 1 ? 'done' : '';
  if(ratio > 1) return 'over';
  if(ratio >= 0.8) return 'warn';
  return '';
}

var editingId = null;    // category currently being edited inline
var lastSpendId = null;  // category whose numbers flash after an expense is added

function escapeAttr(str){ return escapeHtml(str).replace(/"/g, '&quot;'); }

function leftSentence(cat, item){
  var left = Math.round((item.amount - itemSpent(item)) * 100) / 100;
  if(cat === 'savings') return left > 0 ? fmt(left) + ' to go' : 'goal met';
  return left < 0 ? fmt(-left) + ' over budget' : fmt(left) + ' left';
}

function editHtml(cat, item){
  var amt = Math.round(item.amount * 100) / 100;
  return '<div class="item-edit-form" data-cat="' + cat + '" data-id="' + item.id + '">' +
    '<label class="edit-label">Name<input type="text" class="edit-name" maxlength="40" value="' + escapeAttr(item.name) + '"></label>' +
    '<label class="edit-label">' + (cat === 'savings' ? 'Monthly target' : 'Monthly plan') +
      '<span class="edit-money"><span>RM</span><input type="text" class="edit-amount" inputmode="decimal" value="' + amt + '"></span></label>' +
    '<p class="form-msg" role="alert"></p>' +
    '<div class="edit-actions">' +
      '<button type="button" class="text-act danger item-delete" data-cat="' + cat + '" data-id="' + item.id + '">Remove category</button>' +
      '<span class="spacer"></span>' +
      '<button type="button" class="text-act edit-cancel">Cancel</button>' +
      '<button type="button" class="edit-save">Save changes</button>' +
    '</div>' +
  '</div>';
}

function itemHtml(cat, item){
  if(editingId !== null && String(editingId) === String(item.id)) return editHtml(cat, item);

  var saving = cat === 'savings';
  var spent = itemSpent(item);
  var left = Math.round((item.amount - spent) * 100) / 100;
  var ratio = item.amount > 0 ? spent / item.amount : 0;
  var spends = item.spends || [];
  var detail = '';
  if(cat === 'wants' && item.costPerTime != null && item.timesPerMonth != null){
    detail = '<span class="item-detail">' + fmt(item.costPerTime) + ' × ' + item.timesPerMonth + '/mo</span>';
  }

  // Primary number = what is left. Plan and spent are secondary.
  var leftCls = '', leftNum, leftWord = '';
  if(saving){
    if(left <= 0){ leftCls = 'ok'; leftNum = 'Goal met ✓'; }
    else { leftNum = fmt(left); leftWord = ' to go'; }
  } else if(left < 0){
    leftCls = 'bad'; leftNum = fmt(-left); leftWord = ' over budget';
  } else {
    leftNum = fmt(left); leftWord = ' left';
  }

  var rows = spends.slice().reverse().map(function(s){
    return '<li><span class="spend-name">' + escapeHtml(s.name) +
        (s.date ? '<span class="spend-date">' + escapeHtml(s.date) + '</span>' : '') + '</span>' +
      '<span class="spend-right"><span class="spend-amt">' + fmt(s.amount) + '</span>' +
      '<button type="button" class="spend-delete" data-cat="' + cat + '" data-item="' + item.id + '" data-id="' + s.id + '" aria-label="Remove ' + escapeAttr(s.name) + '" title="Remove this entry">×</button></span></li>';
  }).join('');

  var history = rows
    ? '<p class="spend-title">' + (saving ? 'Savings so far' : 'Expenses so far') + '</p><ul class="spend-list">' + rows + '</ul>'
    : '<p class="spend-empty"><b>' + (saving ? 'Nothing saved yet' : 'No expenses yet') + '</b>' +
        (saving ? 'Add what you put aside to start tracking this goal.' : 'Add your first expense to start tracking this category.') + '</p>';

  return '' +
    '<div class="item-head">' +
      '<span class="item-title"><span class="item-name">' + escapeHtml(item.name) + '</span>' + detail +
        '<button type="button" class="text-act item-edit-btn" data-cat="' + cat + '" data-id="' + item.id + '" aria-label="Edit ' + escapeAttr(item.name) + '">Edit</button></span>' +
      '<span class="item-left ' + leftCls + '"><b>' + leftNum + '</b>' + leftWord + '</span>' +
    '</div>' +
    '<div class="item-bar ' + progressClass(spent, item.amount, cat) + '"><span style="width:' + Math.min(ratio * 100, 100) + '%"></span></div>' +
    '<p class="item-sub">' + fmt(spent) + (saving ? ' saved of ' + fmt(item.amount) + ' target' : ' spent of ' + fmt(item.amount) + ' planned') + '</p>' +
    '<details class="item-log" data-id="' + item.id + '"' + (openLogs[item.id] ? ' open' : '') + '>' +
      '<summary>' + (saving ? '+ Add savings' : '+ Add expense') + (spends.length ? ' · ' + spends.length + ' logged' : '') + '</summary>' +
      history +
      '<div class="spend-add">' +
        '<input type="text" class="spend-name-input" placeholder="' + (saving ? 'Note (optional)' : 'What was it? e.g. Lunch') + '" aria-label="What was it">' +
        '<input type="text" class="spend-amount-input" placeholder="RM" inputmode="decimal" aria-label="Amount">' +
        '<button type="button" class="spend-add-btn" data-cat="' + cat + '" data-id="' + item.id + '">' + (saving ? 'Add savings' : 'Add expense') + '</button>' +
      '</div>' +
      '<p class="form-msg" role="alert"></p>' +
    '</details>';
}

// ---------- Render: itemizer per category ----------
function renderItems(cat, skipPulse, animate){
  var list = document.getElementById(cat + 'ItemList');
  var bigLabel = document.getElementById(cat + 'BigLabel');
  var amtEl = document.getElementById(cat + 'Amt');
  var subEl = document.getElementById(cat + 'Sub');
  var skippedNote = document.getElementById(cat + 'SkippedNote');
  var itemizerEl = amtEl.closest('.result-card').querySelector('.itemizer');
  var budgetEl = document.getElementById(cat + 'Budget');
  var spentEl = document.getElementById(cat + 'Spent');
  var spentBar = document.getElementById(cat + 'SpentBar');

  var budget = calcBudgets(state.income)[cat];
  var saving = cat === 'savings';

  var isSkipped = Math.round(budget * 100) / 100 <= 0;
  if(skippedNote) skippedNote.classList.toggle('show', isSkipped);
  if(itemizerEl) itemizerEl.classList.toggle('is-skipped', isSkipped);

  if(isSkipped){
    bigLabel.textContent = 'Skipped';
    amtEl.textContent = fmt(0);
    budgetEl.textContent = fmt(0);
    spentEl.textContent = fmt(0);
    subEl.textContent = 'Nothing allocated here right now.';
    spentBar.style.width = '0%';
    updateOverall();
    return;
  }

  var items = state.items[cat];
  var emptyEl = document.getElementById(cat + 'Empty');
  if(emptyEl) emptyEl.hidden = items.length > 0;
  var planned = categoryTotal(cat);
  var spent = categorySpent(cat);
  var remaining = Math.round((budget - spent) * 100) / 100;

  list.innerHTML = '';
  items.forEach(function(item){
    var li = document.createElement('li');
    li.className = 'line-item' + (item.id === lastAddedItemId ? ' item-enter' : '') + (item.id === lastSpendId ? ' item-flash' : '');
    li.setAttribute('data-id', item.id);
    li.innerHTML = itemHtml(cat, item);
    list.appendChild(li);
  });
  lastAddedItemId = null;
  lastSpendId = null;

  budgetEl.textContent = fmt(budget);
  spentEl.textContent = fmt(spent);
  spentBar.style.width = Math.min(spent / budget * 100, 100) + '%';
  spentBar.classList.toggle('is-over', !saving && spent > budget);

  amtEl.classList.remove('state-done', 'state-over');
  bigLabel.classList.remove('state-done', 'state-over');

  var shown = remaining;
  bigLabel.textContent = saving ? 'Still to save' : 'Left to spend';
  if(remaining === 0 && spent > 0){
    shown = 0;
    if(saving){ bigLabel.textContent = 'Goal reached 🎉'; bigLabel.classList.add('state-done'); amtEl.classList.add('state-done'); }
    else { bigLabel.textContent = 'Fully spent'; }
  } else if(remaining < 0){
    if(saving){
      shown = 0;
      bigLabel.textContent = 'Goal reached 🎉';
      bigLabel.classList.add('state-done');
      amtEl.classList.add('state-done');
    } else {
      shown = -remaining;
      bigLabel.textContent = 'Over budget by';
      bigLabel.classList.add('state-over');
      amtEl.classList.add('state-over');
    }
  }

  if(animate) animateCount(amtEl, shown, 800);
  else amtEl.textContent = fmt(shown);

  // One short, useful line: how much of this budget has no category yet.
  var unplanned = Math.round((budget - planned) * 100) / 100;
  if(items.length === 0) subEl.textContent = '';
  else if(unplanned > 0) subEl.textContent = fmt(unplanned) + ' of this budget isn\'t in a category yet';
  else if(unplanned < 0) subEl.textContent = 'Your categories add up to ' + fmt(planned) + ', which is ' + fmt(-unplanned) + ' over this budget';
  else subEl.textContent = 'Every ringgit has a category.';

  if(!skipPulse){
    amtEl.classList.remove('pulse');
    void amtEl.offsetWidth; // restart animation
    amtEl.classList.add('pulse');
  }
  updateOverall();
}

// ---------- Overall picture (left / spent / saved) ----------
function updateOverall(){
  if(state.income <= 0) return;
  var spentNW = categorySpent('needs') + categorySpent('wants');
  var saved = categorySpent('savings');
  var left = Math.round((state.income - spentNW - saved) * 100) / 100;

  document.getElementById('overallSpent').textContent = fmt(spentNW);
  document.getElementById('overallSaved').textContent = fmt(saved);
  document.getElementById('overallLeft').textContent = fmt(left);
  document.getElementById('overallLeftBox').classList.toggle('is-over', left < 0);
  document.getElementById('leftPillAmt').textContent = fmt(left);
  document.getElementById('leftPill').classList.toggle('is-over', left < 0);

  var spentPct = Math.min(spentNW / state.income * 100, 100);
  var savedPct = Math.min(saved / state.income * 100, 100 - spentPct);
  document.getElementById('overallSpentBar').style.width = spentPct + '%';
  document.getElementById('overallSavedBar').style.width = savedPct + '%';

  renderNextStep();
  updateGrowLeftover(left);
}

function escapeHtml(str){
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Split customizer (priority-based) ----------
function updateSplitUI(){
  var percents = getSplitPercents();
  document.getElementById('needsPriorityPct').textContent = percents.needs + '%';
  document.getElementById('wantsPriorityPct').textContent = percents.wants + '%';
  document.getElementById('savingsPriorityPct').textContent = percents.savings + '%';

  document.querySelectorAll('.priority-pill').forEach(function(pill){
    var cat = pill.getAttribute('data-cat');
    var points = parseInt(pill.getAttribute('data-points'), 10);
    var isActive = state.splitMode === 'priority' && state.priorities[cat] === points;
    pill.classList.toggle('active', isActive);
  });

  if(state.splitMode === 'priority'){
    var totalPoints = state.priorities.needs + state.priorities.wants + state.priorities.savings;
    splitReason.textContent = totalPoints > 0
      ? 'Based on ' + totalPoints + ' total point' + (totalPoints === 1 ? '' : 's') + ' across your three priorities.'
      : 'Pick at least one priority above to build your split.';
  } else {
    splitReason.textContent = '';
  }
}

splitCustomizer.addEventListener('click', function(e){
  var pill = e.target.closest('.priority-pill');
  if(!pill) return;
  var cat = pill.getAttribute('data-cat');
  var points = parseInt(pill.getAttribute('data-points'), 10);
  state.priorities[cat] = points;
  state.splitMode = 'priority';
  updateSplitUI();
  saveState();
  if(state.income > 0) renderResults(false);
});

resetSplitBtn.addEventListener('click', function(){
  state.splitMode = 'default';
  state.priorities = { needs: 3, wants: 2, savings: 1 };
  updateSplitUI();
  saveState();
  if(state.income > 0) renderResults(false);
});

// ---------- Quick amount chips ----------
function setQuickChipActive(amount){
  quickAmounts.querySelectorAll('.quick-chip').forEach(function(chip){
    chip.classList.toggle('active', parseFloat(chip.getAttribute('data-amount')) === amount);
  });
}

quickAmounts.querySelectorAll('.quick-chip').forEach(function(chip){
  chip.addEventListener('click', function(){
    var amount = chip.getAttribute('data-amount');
    incomeInput.value = amount;
    setQuickChipActive(parseFloat(amount));
    if(incomeError.classList.contains('show')) incomeError.classList.remove('show');
    incomeInput.focus();
  });
});

// ---------- Create plan ----------
function handleCreatePlan(){
  var raw = incomeInput.value.trim();
  var amount = parseFloat(raw);
  if(!raw || isNaN(amount) || amount <= 0){
    incomeError.classList.add('show');
    incomeInput.focus();
    return;
  }
  incomeError.classList.remove('show');
  var hadPlan = state.income > 0;
  state.income = amount;
  saveState();
  renderResults(true);
  welcomeBack.classList.remove('show');
  document.body.classList.remove('editing-plan');
  showToast((hadPlan ? 'Plan updated for ' : 'Plan created for ') + fmt(amount));

  setTimeout(function(){
    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
}

// ---------- Numeric input sanitizing ----------
// Cleans up typed or pasted values like "RM 1,000.00" or "1,500" into "1000.00"
// or "1500", so copying a number straight from a banking app still works.
function sanitizeNumericValue(raw){
  var cleaned = raw.replace(/[^0-9.]/g, '');
  var firstDot = cleaned.indexOf('.');
  if(firstDot !== -1){
    cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
  }
  return cleaned;
}

function attachNumericSanitizer(el){
  el.addEventListener('input', function(){
    var sanitized = sanitizeNumericValue(el.value);
    if(sanitized !== el.value) el.value = sanitized;
  });
}

createPlanBtn.addEventListener('click', handleCreatePlan);
incomeInput.addEventListener('keydown', function(e){
  if(e.key === 'Enter') handleCreatePlan();
});
attachNumericSanitizer(incomeInput);
incomeInput.addEventListener('input', function(){
  if(incomeError.classList.contains('show')) incomeError.classList.remove('show');
  setQuickChipActive(parseFloat(incomeInput.value));
});

// ---------- Change amount, cancel, and the "next step" button ----------
function openEditor(){
  document.body.classList.add('editing-plan');
  if(state.income > 0) incomeInput.value = state.income;
  setQuickChipActive(parseFloat(incomeInput.value));
  document.getElementById('calculator').scrollIntoView({ behavior: 'smooth', block: 'start' });
  incomeInput.focus();
}
document.getElementById('changeIncomeBtn').addEventListener('click', openEditor);
document.getElementById('cancelEditBtn').addEventListener('click', function(){
  document.body.classList.remove('editing-plan');
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.getElementById('nextAction').addEventListener('click', function(){
  var action = this.getAttribute('data-action');
  if(action === 'add'){
    var budgets = calcBudgets(state.income);
    var target = ['needs', 'wants', 'savings'].filter(function(c){ return budgets[c] > 0; })[0] || 'needs';
    var det = document.getElementById(target + 'Add');
    det.open = true;
    det.scrollIntoView({ behavior: 'smooth', block: 'center' });
    var f = det.querySelector('.item-name-input');
    if(f) f.focus();
  } else if(action === 'log'){
    var first = null;
    ['needs', 'wants', 'savings'].forEach(function(c){ if(!first && state.items[c].length) first = state.items[c][0]; });
    if(first){
      openLogs[first.id] = true;
      var li = resultsGrid.querySelector('li[data-id="' + first.id + '"]');
      if(li){
        li.querySelector('.item-log').open = true;
        li.scrollIntoView({ behavior: 'smooth', block: 'center' });
        var a = li.querySelector('.spend-amount-input');
        if(a) a.focus();
      }
    }
  } else if(action === 'edit'){
    openEditor();
  } else {
    document.getElementById('grow').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

// ---------- Itemizer interactions (event delegation) ----------
resultsGrid.addEventListener('click', function(e){
  var suggestBtn = e.target.closest('.suggest-chip');
  if(suggestBtn){
    suggestBtn.classList.remove('chip-pop');
    void suggestBtn.offsetWidth; // restart animation if clicked repeatedly
    suggestBtn.classList.add('chip-pop');

    var card = suggestBtn.closest('.result-card');
    var cat = card.getAttribute('data-category');
    var nameInput = card.querySelector('.item-name-input');
    nameInput.value = suggestBtn.getAttribute('data-name');

    if(cat === 'wants'){
      var costAttr = suggestBtn.getAttribute('data-cost');
      var costInput = card.querySelector('.item-cost-input');
      if(costAttr) costInput.value = costAttr;

      var timesAttr = suggestBtn.getAttribute('data-times');
      var timesInput = card.querySelector('.item-times-input');
      if(timesAttr) timesInput.value = timesAttr;

      updateWantsPreview(card);
      costInput.focus();
    } else {
      card.querySelector('.item-amount-input').focus();
    }
    return;
  }

  var addBtn = e.target.closest('.item-add-btn');
  if(addBtn){
    addItemFromCard(addBtn.closest('.result-card'));
    return;
  }

  var editBtn = e.target.closest('.item-edit-btn');
  if(editBtn){
    var prevForm = resultsGrid.querySelector('.item-edit-form');
    var prevCat = prevForm ? prevForm.getAttribute('data-cat') : null;
    var editCat = editBtn.getAttribute('data-cat');
    editingId = editBtn.getAttribute('data-id');
    renderItems(editCat);
    if(prevCat && prevCat !== editCat) renderItems(prevCat);
    var nameField = resultsGrid.querySelector('.item-edit-form .edit-name');
    if(nameField) nameField.focus();
    return;
  }

  var saveBtn = e.target.closest('.edit-save');
  if(saveBtn){
    saveEdit(saveBtn.closest('.item-edit-form'));
    return;
  }

  var cancelBtn = e.target.closest('.edit-cancel');
  if(cancelBtn){
    var cancelForm = cancelBtn.closest('.item-edit-form');
    editingId = null;
    renderItems(cancelForm.getAttribute('data-cat'));
    return;
  }

  var spendAddBtn = e.target.closest('.spend-add-btn');
  if(spendAddBtn){
    addSpend(spendAddBtn);
    return;
  }

  var spendDel = e.target.closest('.spend-delete');
  if(spendDel){
    var sCat = spendDel.getAttribute('data-cat');
    var sItem = findItem(sCat, spendDel.getAttribute('data-item'));
    if(sItem){
      var sid = spendDel.getAttribute('data-id');
      var sIdx = -1;
      (sItem.spends || []).forEach(function(s, i){ if(String(s.id) === String(sid)) sIdx = i; });
      if(sIdx !== -1){
        var removedSpend = sItem.spends.splice(sIdx, 1)[0];
        openLogs[sItem.id] = true;
        saveState();
        renderItems(sCat);
        showToast('Removed ' + removedSpend.name + ' · ' + sItem.name + ': ' + leftSentence(sCat, sItem), { undo: function(){
          sItem.spends.splice(sIdx, 0, removedSpend);
          openLogs[sItem.id] = true;
          saveState();
          renderItems(sCat);
        }});
      }
    }
    return;
  }

  var deleteBtn = e.target.closest('.item-delete');
  if(deleteBtn){
    var delCat = deleteBtn.getAttribute('data-cat');
    var id = deleteBtn.getAttribute('data-id');
    var delIdx = -1;
    state.items[delCat].forEach(function(item, i){ if(String(item.id) === String(id)) delIdx = i; });
    if(delIdx !== -1){
      var removedItem = state.items[delCat].splice(delIdx, 1)[0];
      editingId = null;
      saveState();
      renderItems(delCat);
      showToast('Removed ' + removedItem.name, { undo: function(){
        state.items[delCat].splice(Math.min(delIdx, state.items[delCat].length), 0, removedItem);
        saveState();
        renderItems(delCat);
      }});
    }
  }
});

function addSpend(btn){
  var cat = btn.getAttribute('data-cat');
  var id = btn.getAttribute('data-id');
  var wrap = btn.closest('.spend-add');
  var scope = btn.closest('.item-log');
  var nameInput = wrap.querySelector('.spend-name-input');
  var amountInput = wrap.querySelector('.spend-amount-input');
  var item = findItem(cat, id);
  if(!item) return;

  clearErrors(scope);
  var amount = parseFloat(amountInput.value);
  if(isNaN(amount) || amount <= 0){
    flagError(scope, amountInput, 'Enter an amount, like 20.');
    return;
  }
  var name = nameInput.value.trim() || (cat === 'savings' ? 'Saved' : 'Spent');
  if(!Array.isArray(item.spends)) item.spends = [];
  item.spends.push({
    id: Date.now() + Math.random().toString(16).slice(2),
    name: name,
    amount: amount,
    date: new Date().toLocaleDateString('en-MY', { day: 'numeric', month: 'short' })
  });
  openLogs[id] = true;
  lastSpendId = item.id;
  saveState();
  renderItems(cat);

  var left = item.amount - itemSpent(item);
  if(cat === 'savings'){
    showToast('Savings added · ' + item.name + ': ' + leftSentence(cat, item));
  } else if(left < 0){
    showToast('Expense added · ' + item.name + ' is ' + fmt(-left) + ' over budget', { tone: 'warn' });
  } else {
    showToast('Expense added · ' + item.name + ' now has ' + fmt(left) + ' left');
  }

  var again = resultsGrid.querySelector('li[data-id="' + id + '"] .spend-name-input');
  if(again) again.focus();
}

resultsGrid.addEventListener('keydown', function(e){
  if(e.target.classList.contains('edit-name') || e.target.classList.contains('edit-amount')){
    if(e.key === 'Enter'){
      e.preventDefault();
      saveEdit(e.target.closest('.item-edit-form'));
    } else if(e.key === 'Escape'){
      var escForm = e.target.closest('.item-edit-form');
      editingId = null;
      renderItems(escForm.getAttribute('data-cat'));
    }
    return;
  }
  if(e.key === 'Enter' && (e.target.classList.contains('spend-name-input') || e.target.classList.contains('spend-amount-input'))){
    e.preventDefault();
    addSpend(e.target.closest('.spend-add').querySelector('.spend-add-btn'));
    return;
  }
  var isItemField = e.target.classList.contains('item-name-input') ||
    e.target.classList.contains('item-amount-input') ||
    e.target.classList.contains('item-cost-input') ||
    e.target.classList.contains('item-times-input');
  if(e.key === 'Enter' && isItemField){
    e.preventDefault();
    addItemFromCard(e.target.closest('.result-card'));
  }
});

resultsGrid.addEventListener('input', function(e){
  var errScope = e.target.closest('.add-cat-body, .item-log, .item-edit-form');
  if(errScope && errScope.querySelector('.has-error, .form-msg.show')) clearErrors(errScope);
  if(e.target.classList.contains('item-amount-input') || e.target.classList.contains('item-cost-input') || e.target.classList.contains('spend-amount-input') || e.target.classList.contains('edit-amount')){
    var sanitized = sanitizeNumericValue(e.target.value);
    if(sanitized !== e.target.value) e.target.value = sanitized;
  }
  if(e.target.classList.contains('item-times-input')){
    var wholeNumber = e.target.value.replace(/[^0-9]/g, '');
    if(wholeNumber !== e.target.value) e.target.value = wholeNumber;
  }
  if(e.target.classList.contains('item-cost-input') || e.target.classList.contains('item-times-input')){
    var wantsCard = e.target.closest('.result-card');
    updateWantsPreview(wantsCard);
  }
});

// <details> toggle events don't bubble, so listen in the capture phase.
resultsGrid.addEventListener('toggle', function(e){
  var t = e.target;
  if(t.classList && t.classList.contains('item-log')) openLogs[t.getAttribute('data-id')] = t.open;
}, true);

function updateWantsPreview(card){
  var previewEl = card.querySelector('.wants-preview');
  if(!previewEl) return;
  var cost = parseFloat(card.querySelector('.item-cost-input').value);
  var timesRaw = card.querySelector('.item-times-input').value.trim();
  var times = timesRaw === '' ? 1 : parseInt(timesRaw, 10);

  if(isNaN(cost) || cost <= 0){
    previewEl.textContent = '';
    return;
  }
  previewEl.textContent = '= ' + fmt(cost * times) + ' / month';
}

function addItemFromCard(card){
  var cat = card.getAttribute('data-category');
  var nameInput = card.querySelector('.item-name-input');
  var name = nameInput.value.trim();

  var scope = card.querySelector('.add-cat-body') || card;
  clearErrors(scope);
  if(!name){
    flagError(scope, nameInput, 'Give it a name, like ' + ({ needs: 'Food', wants: 'Coffee', savings: 'Emergency fund' }[cat]) + '.');
    return;
  }

  if(cat === 'wants'){
    var costInput = card.querySelector('.item-cost-input');
    var timesInput = card.querySelector('.item-times-input');
    var cost = parseFloat(costInput.value);
    var timesRaw = timesInput.value.trim();
    var times = timesRaw === '' ? 1 : parseInt(timesRaw, 10);

    if(isNaN(cost) || cost <= 0){
      flagError(scope, costInput, 'Enter what it costs each time, like 12.');
      return;
    }
    if(isNaN(times) || times <= 0) times = 1;

    var newItem = {
      id: Date.now() + Math.random().toString(16).slice(2),
      name: name,
      costPerTime: cost,
      timesPerMonth: times,
      amount: cost * times
    };
    state.items.wants.push(newItem);
    saveState();

    nameInput.value = '';
    costInput.value = '';
    timesInput.value = '';
    card.querySelector('.wants-preview').textContent = '';
    nameInput.focus();
    lastAddedItemId = newItem.id;
    renderItems('wants');
    showToast('Category added · ' + name + ', plan ' + fmt(newItem.amount));
    return;
  }

  var amountInput = card.querySelector('.item-amount-input');
  var amount = parseFloat(amountInput.value);
  if(isNaN(amount) || amount <= 0){
    flagError(scope, amountInput, 'Enter your plan for the month, like 200.');
    return;
  }

  var newBasicItem = {
    id: Date.now() + Math.random().toString(16).slice(2),
    name: name,
    amount: amount
  };
  state.items[cat].push(newBasicItem);
  saveState();

  nameInput.value = '';
  amountInput.value = '';
  nameInput.focus();
  lastAddedItemId = newBasicItem.id;
  renderItems(cat);
  showToast('Category added · ' + name + ', plan ' + fmt(amount));
}

function saveEdit(form){
  if(!form) return;
  var cat = form.getAttribute('data-cat');
  var item = findItem(cat, form.getAttribute('data-id'));
  if(!item) return;
  var nameEl = form.querySelector('.edit-name');
  var amtEl = form.querySelector('.edit-amount');
  var name = nameEl.value.trim();
  var amount = parseFloat(amtEl.value);
  clearErrors(form);
  if(!name){ flagError(form, nameEl, 'Give it a name.'); return; }
  if(isNaN(amount) || amount <= 0){ flagError(form, amtEl, 'Enter a plan for the month, like 200.'); return; }
  // A want's "cost × times" breakdown no longer applies if its total was changed by hand.
  if(item.costPerTime != null && item.timesPerMonth != null &&
     Math.abs(amount - item.costPerTime * item.timesPerMonth) > 0.001){
    item.costPerTime = null;
    item.timesPerMonth = null;
  }
  item.name = name;
  item.amount = amount;
  editingId = null;
  lastSpendId = item.id;
  saveState();
  renderItems(cat);
  showToast('Changes saved · ' + name + ' plan is ' + fmt(amount) + ' (' + leftSentence(cat, item) + ')');
}

// ---------- "Where am I?" — highlight the current section in the menu ----------
function handleSpy(){
  var current = null;
  ['how-it-works', 'results', 'grow', 'faq'].forEach(function(id){
    var el = document.getElementById(id);
    if(!el || !el.offsetParent) return;           // hidden sections can't be "current"
    if(el.getBoundingClientRect().top <= 140) current = id;
  });
  document.querySelectorAll('.nav-links a, .mobile-menu a:not(.mobile-menu-cta)').forEach(function(a){
    var on = a.getAttribute('href') === '#' + current;
    a.classList.toggle('active', on);
    if(on) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
  });
}
window.addEventListener('scroll', handleSpy, { passive: true });

// ---------- Copy / print plan ----------
function buildPlanText(){
  var budgets = calcBudgets(state.income);
  var percents = getSplitPercents();
  var lines = [];
  lines.push('My money plan — MoneyWise');
  lines.push('Total: ' + fmt(state.income));
  var spentNW = categorySpent('needs') + categorySpent('wants');
  var savedAll = categorySpent('savings');
  lines.push('Spent: ' + fmt(spentNW) + ' · Saved: ' + fmt(savedAll) + ' · Left: ' + fmt(state.income - spentNW - savedAll));
  lines.push('');

  ['needs', 'wants', 'savings'].forEach(function(cat){
    var word = cat === 'savings' ? 'Saved' : 'Spent';
    var catSpent = categorySpent(cat);
    lines.push(categoryLabels[cat] + ' (' + percents[cat] + '%): Budget ' + fmt(budgets[cat]) + ' · ' + word + ' ' + fmt(catSpent) + ' · Left ' + fmt(budgets[cat] - catSpent));

    state.items[cat].forEach(function(item){
      var label = item.name;
      if(cat === 'wants' && item.costPerTime != null && item.timesPerMonth != null){
        label += ' (' + fmt(item.costPerTime) + ' × ' + item.timesPerMonth + '/mo)';
      }
      lines.push('  - ' + label + ': plan ' + fmt(item.amount) + ', ' + word.toLowerCase() + ' ' + fmt(itemSpent(item)) + ', left ' + fmt(item.amount - itemSpent(item)));
      (item.spends || []).forEach(function(s){
        lines.push('      · ' + s.name + ' ' + fmt(s.amount));
      });
    });
    lines.push('');
  });

  return lines.join('\n').trim();
}

function showCopyFeedback(message){
  copyFeedback.textContent = message;
  setTimeout(function(){ copyFeedback.textContent = ''; }, 2500);
}

// ---------- Shareable plan image ----------
// Draws a portrait card (1080x1350, story-friendly) summarizing the plan,
// with the brand ring redrawn using the person's *actual* split rather than
// the generic 50/30/20 demo — every number on the image comes straight from
// their real data.
function roundRectPath(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawShareRing(ctx, cx, cy, r, strokeWidth, percents){
  var order = ['needs', 'wants', 'savings'];
  var colors = ['#FFFFFF', 'rgba(255,255,255,0.75)', 'rgba(255,255,255,0.45)'];
  var gap = 0.05;
  var start = -Math.PI / 2;
  order.forEach(function(key, i){
    var frac = Math.max(percents[key] / 100, 0);
    var sweep = Math.max(frac * Math.PI * 2 - gap, 0);
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + sweep);
    ctx.strokeStyle = colors[i];
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = 'round';
    ctx.stroke();
    start += frac * Math.PI * 2;
  });
}

function generatePlanImage(){
  if(state.income <= 0) return;
  var budgets = calcBudgets(state.income);
  var percents = getSplitPercents();
  var sans = '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif';

  var canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1350;
  var ctx = canvas.getContext('2d');

  var grad = ctx.createLinearGradient(0, 0, 1080, 1350);
  grad.addColorStop(0, '#6C4BF4');
  grad.addColorStop(1, '#4B32B8');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1080, 1350);

  drawShareRing(ctx, 108, 110, 34, 9, percents);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '700 34px ' + sans;
  ctx.textBaseline = 'middle';
  ctx.fillText('MoneyWise', 168, 118);

  ctx.font = '500 28px ' + sans;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText('My money plan', 90, 250);

  ctx.font = '800 92px ' + sans;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(fmt(state.income), 90, 350);

  var cats = [
    { key: 'needs', label: 'NEEDS', color: '#4B32B8' },
    { key: 'wants', label: 'WANTS', color: '#6C4BF4' },
    { key: 'savings', label: 'SAVINGS', color: '#8A72E8' }
  ];
  var cardY = 470;
  cats.forEach(function(c){
    roundRectPath(ctx, 90, cardY, 900, 180, 28);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();

    ctx.fillStyle = c.color;
    ctx.font = '700 26px ' + sans;
    ctx.fillText(c.label + '   ·   ' + percents[c.key] + '%', 130, cardY + 58);

    ctx.fillStyle = '#17151F';
    ctx.font = '800 62px ' + sans;
    ctx.fillText(fmt(budgets[c.key]), 130, cardY + 128);

    cardY += 210;
  });

  ctx.textAlign = 'center';
  ctx.font = '500 24px ' + sans;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText('Made with MoneyWise', 540, 1290);
  ctx.textAlign = 'left';

  var link = document.createElement('a');
  link.download = 'my-money-plan.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
}

var savePlanImageBtn = document.getElementById('savePlanImageBtn');
savePlanImageBtn.addEventListener('click', generatePlanImage);

copyPlanBtn.addEventListener('click', function(){
  if(state.income <= 0) return;
  var text = buildPlanText();

  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){
      showCopyFeedback('Copied! Paste it anywhere you like.');
    }).catch(function(){
      fallbackCopy(text);
    });
  } else {
    fallbackCopy(text);
  }
});

var whatsappShareBtn = document.getElementById('whatsappShareBtn');
whatsappShareBtn.addEventListener('click', function(e){
  e.preventDefault();
  if(state.income <= 0) return;
  var text = buildPlanText();
  var url = 'https://wa.me/?text=' + encodeURIComponent(text);
  window.open(url, '_blank', 'noopener');
});

function fallbackCopy(text){
  var textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try{
    document.execCommand('copy');
    showCopyFeedback('Copied! Paste it anywhere you like.');
  } catch(e){
    showCopyFeedback('Could not copy automatically — please copy manually.');
  }
  document.body.removeChild(textarea);
}

printPlanBtn.addEventListener('click', function(){
  if(state.income <= 0) return;
  window.print();
});

var resetPlanBtn = document.getElementById('resetPlanBtn');
resetPlanBtn.addEventListener('click', function(){
  var confirmed = window.confirm('Clear your saved plan and start fresh? This can\'t be undone.');
  if(!confirmed) return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(OLD_INCOME_KEY);
  location.reload();
});

// ---------- Grow Your Money ----------
// Costs are rough estimates (ringgit). Each cost line is [label, low, high].
var OPPS = [
  {
    id: 'website',
    title: 'Build a website with AI tools',
    tag: 'Use AI builders such as Base44, Lovable or Claude to build a site people can visit.',
    tags: ['web'], hours: 6, skillMin: 1, risk: 2,
    skills: 'Beginner → Intermediate',
    time: 'Medium · about 5–8 hrs/week',
    riskLabel: 'Medium',
    tools: 'AI builder (Base44, Lovable, Claude) + domain + hosting',
    revenue: 'Ads (e.g. Google Ads) · services · digital products · affiliate links',
    costs: [
      ['Domain name (per year)', 40, 70],
      ['Hosting (often included in the builder plan)', 0, 60],
      ['AI tool (first month)', 0, 90],
      ['Templates', 0, 50],
      ['Marketing', 0, 100]
    ],
    flow: ['Idea', 'Build website', 'Buy domain', 'Host website', 'Market website', 'Get visitors', 'Monetize'],
    steps: ['Choose an idea.', 'Build a simple version.', 'Buy a domain.', 'Publish the website.', 'Create social-media content.', 'Get visitors.', 'Improve the website based on feedback.'],
    marketing: {
      title: 'Marketing the website (TikTok, Instagram, YouTube)',
      flow: ['Create website', 'Create content', 'Post content', 'Get visitors', 'Build audience', 'Monetize'],
      note: 'Possible extra costs: AI tools, editing tools, advertising, domain, hosting.'
    },
    watch: ['New sites usually get very few visitors at first. Traffic takes time and steady content.', 'Ad income normally needs consistent traffic before it adds up.']
  },
  {
    id: 'video',
    title: 'AI video and content creation',
    tag: 'Learn copywriting, video and AI animation, then publish on platforms like YouTube.',
    tags: ['video'], hours: 8, skillMin: 1, risk: 3,
    skills: 'Beginner → Intermediate',
    time: 'High · about 8–10 hrs/week, every week',
    riskLabel: 'Medium–High',
    tools: 'AI video tools (e.g. Higgsfield, Toonbee) + an editing app',
    revenue: 'YouTube monetization · sponsorships · services · affiliate links',
    costs: [
      ['AI video / animation tool (per month)', 0, 150],
      ['Editing tool', 0, 60],
      ['Voiceover and music', 0, 40],
      ['Boosting posts (optional)', 0, 50]
    ],
    flow: ['Learn the skills', 'Make videos', 'Publish', 'Build an audience', 'Monetize'],
    steps: ['Pick a topic you can make videos about every week.', 'Learn the basics of copywriting: hooks and scripts.', 'Try the free tiers of AI video tools first.', 'Make three short test videos.', 'Publish on YouTube, TikTok or Instagram.', 'Check what people actually watch.', 'Only then consider paid tools.'],
    watch: ['Tools may require subscriptions, and free tiers are limited.', 'YouTube monetization has eligibility rules and can take a long time. Income is not guaranteed.']
  },
  {
    id: 'agents',
    title: 'Learn to build AI agents',
    tag: 'Build small AI agents that do a useful job, then offer that as a service.',
    tags: ['ai'], hours: 8, skillMin: 2, risk: 3,
    skills: 'Intermediate → Advanced',
    time: 'High · about 8–12 hrs/week',
    riskLabel: 'Medium–High',
    tools: 'AI subscription + APIs + a hosting spot for your agent',
    revenue: 'Freelance work on Fiverr or Upwork · direct clients',
    costs: [
      ['AI subscription (per month)', 0, 90],
      ['API usage while testing', 10, 80],
      ['Hosting for your agent', 0, 60],
      ['Other software', 0, 50]
    ],
    flow: ['Learn AI agents', 'Build an agent', 'Create a useful service', 'Find clients', 'Sell the service'],
    steps: ['Learn what AI agents are using free tutorials.', 'Build one small agent for a real task.', 'Test it on your own task or a friend\'s.', 'Package it as a simple service with a clear price.', 'Create a profile on Fiverr or Upwork.', 'Pitch to a few clients.', 'Improve it from feedback.'],
    note: 'Money invested is what you pay for tools and learning, and that part is certain. The potential opportunity is what clients might pay you, and that part is not.',
    watch: ['Freelance platforms take a fee from what you earn, and competition is real.', 'Clients pay for results, not for the tools you used.']
  },
  {
    id: 'product',
    title: 'Sell digital products',
    tag: 'Create (or properly license) digital products, then sell them on a suitable platform.',
    tags: ['product'], hours: 4, skillMin: 1, risk: 1,
    skills: 'Beginner',
    time: 'Low–Medium · about 3–5 hrs/week',
    riskLabel: 'Low–Medium',
    tools: 'A design or editing tool + a marketplace (e.g. Etsy, Facebook Marketplace)',
    revenue: 'Product sales on marketplaces or your own site',
    costs: [
      ['Design or editing tool', 0, 60],
      ['Licence for ready-made content (only if you buy it)', 0, 100],
      ['Platform listing and sales fees', 5, 50],
      ['Mockups and marketing', 0, 40]
    ],
    flow: ['Find or create a product', 'Check licence and resale rights', 'Market it', 'Sell on a suitable platform'],
    steps: ['Pick a small problem people would pay to solve.', 'Create the product yourself, or confirm you have the right to sell it.', 'Check licence, resale rights, commercial-use rights, platform rules and copyright.', 'Make clear preview images.', 'List it on a platform that allows it.', 'Share it where your buyers are.', 'Improve it from feedback.'],
    licence: ['Licence', 'Resale rights', 'Commercial-use rights', 'Platform rules', 'Copyright'],
    watch: ['Many platforms have their own rules about digital items. Read them before you list.', 'Making your own product is the safest route.']
  }
];

var openOpp = {};
var growBudgetInput = document.getElementById('growBudget');

function rm(n){ return 'RM ' + Math.round(n).toLocaleString('en-MY'); }
function rmRange(lo, hi){
  return lo === hi ? rm(lo) : 'RM ' + Math.round(lo).toLocaleString('en-MY') + '–' + Math.round(hi).toLocaleString('en-MY');
}

function oppTotals(o){
  var lo = 0, hi = 0;
  o.costs.forEach(function(c){ lo += c[1]; hi += c[2]; });
  return { lo: lo, hi: hi };
}

function scoreOpp(o, g){
  var score = 0, why = [];
  if(g.interest && o.tags.indexOf(g.interest) !== -1){ score += 3; why.push('matches what you want to do'); }
  if(g.time){
    var hrs = { low: 3, mid: 6, high: 10 }[g.time];
    if(hrs >= o.hours){ score += 1; why.push('fits the time you have'); }
  }
  if(g.risk){
    if(o.risk <= g.risk){ score += 2; why.push('sits within the risk you\'re comfortable with'); }
    else score -= 1;
  }
  if(g.level){
    if(o.skillMin <= g.level){ score += 1; why.push('suits your experience'); }
    else score -= 1;
  }
  return { score: score, why: why };
}

function flowHtml(steps){
  return '<div class="flow">' + steps.map(function(s){ return '<span>' + s + '</span>'; }).join('<i aria-hidden="true">→</i>') + '</div>';
}

function oppCardHtml(row, bestId, hasBudget){
  var o = row.o, t = row.t, g = state.grow;
  var done = state.steps[o.id] || [];
  var doneCount = 0;
  o.steps.forEach(function(s, i){ if(done[i]) doneCount++; });
  var riskCls = o.risk === 1 ? 'risk-low' : (o.risk === 2 ? 'risk-med' : 'risk-high');

  var costRows = o.costs.map(function(c){
    return '<tr><td>' + c[0] + '</td><td>' + rmRange(c[1], c[2]) + '</td></tr>';
  }).join('');

  var stepsHtml = o.steps.map(function(s, i){
    return '<li><label class="step-check"><input type="checkbox" data-opp="' + o.id + '" data-i="' + i + '"' + (done[i] ? ' checked' : '') + '><span>' + s + '</span></label></li>';
  }).join('');

  var whyParts = row.why.slice();
  if(hasBudget && row.fits) whyParts.unshift('fits your budget of ' + rm(g.budget));
  var whyHtml = (row.fits && whyParts.length)
    ? '<p class="why">Why it may fit: ' + whyParts.join(', ') + '.</p>' : '';

  var lockedHtml = row.fits ? '' : '<p class="locked-note">You\'d need about ' + rm(t.lo) + ' to start this one.</p>';
  var badge = (bestId === o.id) ? '<span class="opp-badge">Best fit</span>' : '';

  var marketingHtml = '';
  if(o.marketing){
    marketingHtml = '<div class="opp-sub"><p class="opp-sub-title">' + o.marketing.title + '</p>' + flowHtml(o.marketing.flow) +
      '<p class="opp-small">' + o.marketing.note + '</p></div>';
  }
  var noteHtml = o.note ? '<p class="opp-small opp-note">' + o.note + '</p>' : '';
  var licenceHtml = '';
  if(o.licence){
    licenceHtml = '<div class="license-box"><strong>Don\'t assume you can resell it.</strong> Not every digital product can legally be bought and resold. Before selling anything you didn\'t make, check: ' +
      o.licence.join(' · ') + '. If the licence doesn\'t clearly allow it, don\'t sell it.</div>';
  }

  return '' +
    '<article class="card opp-card' + (row.fits ? '' : ' is-locked') + '" data-id="' + o.id + '">' + badge +
      '<h3 class="opp-title">' + o.title + '</h3>' +
      '<p class="opp-tag">' + o.tag + '</p>' +
      whyHtml + lockedHtml +
      '<div class="opp-cost">' +
        '<div><span>Estimated starting cost</span><b>' + rmRange(t.lo, t.hi) + '</b></div>' +
        '<div class="opp-risk ' + riskCls + '"><span>Risk</span><b>' + o.riskLabel + '</b></div>' +
      '</div>' +
      '<p class="opp-line"><b>Skills:</b> ' + o.skills + '<br><b>Time:</b> ' + o.time + '</p>' +
      '<p class="opp-income">Income is not guaranteed.</p>' +
      licenceHtml +
      '<details class="opp-more" data-id="' + o.id + '"' + (openOpp[o.id] ? ' open' : '') + '>' +
        '<summary>See costs, steps and risks <span class="step-count">(' + doneCount + '/' + o.steps.length + ' steps done)</span></summary>' +
        '<div class="opp-detail">' +
          '<p class="opp-fact"><b>Tools:</b> ' + o.tools + '</p>' +
          '<p class="opp-fact"><b>Possible revenue:</b> ' + o.revenue + '</p>' +
          '<p class="opp-sub-title">What the starting cost covers</p>' +
          '<table class="cost-table"><tbody>' + costRows + '</tbody>' +
            '<tfoot><tr><td>Total estimated initial cost</td><td>' + rmRange(t.lo, t.hi) + '</td></tr></tfoot></table>' +
          noteHtml +
          '<p class="opp-sub-title">How it works</p>' + flowHtml(o.flow) + marketingHtml +
          '<p class="opp-sub-title">First steps</p>' +
          '<ol class="step-list">' + stepsHtml + '</ol>' +
          '<p class="opp-sub-title">Watch out for</p>' +
          '<ul class="opp-watch">' + o.watch.map(function(w){ return '<li>' + w + '</li>'; }).join('') + '</ul>' +
        '</div>' +
      '</details>' +
    '</article>';
}

function renderGrow(){
  var g = state.grow;
  var hasBudget = typeof g.budget === 'number' && !isNaN(g.budget);
  var answered = !!(g.time || g.interest || g.risk || g.level);

  var rows = OPPS.map(function(o){
    var t = oppTotals(o);
    var s = scoreOpp(o, g);
    return { o: o, t: t, fits: !hasBudget || g.budget >= t.lo, score: s.score, why: s.why };
  });
  if(hasBudget || answered){
    rows.sort(function(a, b){
      if(a.fits !== b.fits) return a.fits ? -1 : 1;
      if(b.score !== a.score) return b.score - a.score;
      return a.t.lo - b.t.lo;
    });
  }

  var fitCount = rows.filter(function(r){ return r.fits; }).length;
  var heading = document.getElementById('growHeading');
  if(hasBudget && fitCount === 0){
    var cheapest = Math.min.apply(null, rows.map(function(r){ return r.t.lo; }));
    heading.textContent = 'Nothing here is realistic to start with ' + rm(g.budget) + ' (the cheapest needs about ' + rm(cheapest) + '). Building your savings first is a good move too.';
  } else if(hasBudget){
    heading.textContent = 'Based on your available budget of ' + rm(g.budget) + ', these options may be more suitable.' +
      (fitCount < rows.length ? ' The rest need a bigger budget and are shown below.' : '');
  } else {
    heading.textContent = 'Four ways to turn money, time and skills into something that might earn. Answer the questions above to narrow them down.';
  }

  var bestId = (answered && rows[0].fits && rows[0].score > 0) ? rows[0].o.id : null;
  var html = '';
  var dividerShown = false;
  rows.forEach(function(r){
    if(hasBudget && !r.fits && !dividerShown && fitCount > 0){
      html += '<p class="opp-divider">Needs a bigger budget</p>';
      dividerShown = true;
    }
    html += oppCardHtml(r, bestId, hasBudget);
  });
  document.getElementById('oppGrid').innerHTML = html;
}

function syncGrowUI(){
  document.querySelectorAll('#grow .choice-pill').forEach(function(p){
    var q = p.getAttribute('data-q');
    var v = p.getAttribute('data-v');
    if(q === 'risk' || q === 'level') v = parseInt(v, 10);
    p.classList.toggle('active', state.grow[q] === v);
  });
  document.querySelectorAll('#grow .grow-chip').forEach(function(c){
    c.classList.toggle('active', parseFloat(c.getAttribute('data-amount')) === state.grow.budget && !c.hidden);
  });
}

function setGrowBudget(n){
  state.grow.budget = (n === null || isNaN(n)) ? null : n;
  growBudgetInput.value = state.grow.budget === null ? '' : state.grow.budget;
  saveState();
  syncGrowUI();
  renderGrow();
}

function updateGrowLeftover(left){
  var chip = document.getElementById('growLeftoverChip');
  var note = document.getElementById('growLeftoverNote');
  if(!chip || !note) return;
  var usable = Math.floor(left);
  if(state.income > 0 && usable > 0){
    chip.hidden = false;
    chip.setAttribute('data-amount', usable);
    chip.textContent = 'Use my money left (RM ' + usable.toLocaleString('en-MY') + ')';
    note.textContent = 'You have ' + fmt(left) + ' unspent this month. Make sure rent, food and bills for the rest of the month are covered before putting any into something new.';
  } else {
    chip.hidden = true;
    note.textContent = '';
  }
  syncGrowUI();
}

attachNumericSanitizer(growBudgetInput);
growBudgetInput.addEventListener('input', function(){
  var raw = growBudgetInput.value.trim();
  var n = parseFloat(raw);
  state.grow.budget = (raw === '' || isNaN(n)) ? null : n;
  saveState();
  syncGrowUI();
  renderGrow();
});

document.getElementById('grow').addEventListener('click', function(e){
  var pill = e.target.closest('.choice-pill');
  if(pill){
    var q = pill.getAttribute('data-q');
    var v = pill.getAttribute('data-v');
    if(q === 'risk' || q === 'level') v = parseInt(v, 10);
    state.grow[q] = state.grow[q] === v ? null : v;
    saveState();
    syncGrowUI();
    renderGrow();
    return;
  }
  var chip = e.target.closest('.grow-chip');
  if(chip){
    setGrowBudget(parseFloat(chip.getAttribute('data-amount')));
    return;
  }
  if(e.target.closest('#growClear')){
    state.grow = { budget: null, time: null, interest: null, risk: null, level: null };
    growBudgetInput.value = '';
    saveState();
    syncGrowUI();
    renderGrow();
  }
});

var oppGridEl = document.getElementById('oppGrid');
oppGridEl.addEventListener('change', function(e){
  var box = e.target;
  if(!box.matches || !box.matches('.step-check input')) return;
  var id = box.getAttribute('data-opp');
  var i = parseInt(box.getAttribute('data-i'), 10);
  if(!Array.isArray(state.steps[id])) state.steps[id] = [];
  state.steps[id][i] = box.checked;
  saveState();
  var opp = OPPS.filter(function(o){ return o.id === id; })[0];
  var count = 0;
  opp.steps.forEach(function(s, k){ if(state.steps[id][k]) count++; });
  var label = box.closest('.opp-more').querySelector('.step-count');
  if(label) label.textContent = '(' + count + '/' + opp.steps.length + ' steps done)';
});
oppGridEl.addEventListener('toggle', function(e){
  var t = e.target;
  if(t.classList && t.classList.contains('opp-more')) openOpp[t.getAttribute('data-id')] = t.open;
}, true);

function initGrow(){
  var b = state.grow.budget;
  growBudgetInput.value = (typeof b === 'number' && !isNaN(b)) ? b : '';
  if(state.grow.time || state.grow.risk || state.grow.level){
    document.getElementById('growRefine').open = true;
  }
  syncGrowUI();
  renderGrow();
}

// ---------- Mobile menu ----------
var menuToggle = document.getElementById('menuToggle');
var mobileMenu = document.getElementById('mobileMenu');

function closeMobileMenu(){
  menuToggle.classList.remove('open');
  menuToggle.setAttribute('aria-expanded', 'false');
  mobileMenu.classList.remove('open');
}

menuToggle.addEventListener('click', function(){
  var isOpen = mobileMenu.classList.toggle('open');
  menuToggle.classList.toggle('open', isOpen);
  menuToggle.setAttribute('aria-expanded', String(isOpen));
});

mobileMenu.querySelectorAll('a').forEach(function(link){
  link.addEventListener('click', closeMobileMenu);
});

document.addEventListener('click', function(e){
  var isOpen = mobileMenu.classList.contains('open');
  if(!isOpen) return;
  var clickedInsideMenu = mobileMenu.contains(e.target);
  var clickedToggle = menuToggle.contains(e.target);
  if(!clickedInsideMenu && !clickedToggle) closeMobileMenu();
});

document.addEventListener('keydown', function(e){
  if(e.key === 'Escape' && mobileMenu.classList.contains('open')){
    closeMobileMenu();
    menuToggle.focus();
  }
});

// ---------- Nav scroll shadow ----------
function handleNavScroll(){
  if(window.scrollY > 8) navbar.classList.add('scrolled');
  else navbar.classList.remove('scrolled');
}
window.addEventListener('scroll', handleNavScroll, { passive: true });

// ---------- Back to calculator ----------
var backToCalc = document.getElementById('backToCalc');
function handleBackToCalcVisibility(){
  if(window.scrollY > 900) backToCalc.classList.add('show');
  else backToCalc.classList.remove('show');
}
window.addEventListener('scroll', handleBackToCalcVisibility, { passive: true });
backToCalc.addEventListener('click', function(){
  var dest = document.body.classList.contains('has-plan') ? 'results' : 'calculator';
  document.getElementById(dest).scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ---------- Scroll reveal ----------
function initScrollReveal(){
  var revealEls = document.querySelectorAll('.reveal');
  if(!('IntersectionObserver' in window) || revealEls.length === 0){
    revealEls.forEach(function(el){ el.classList.add('in-view'); });
    return;
  }
  var observer = new IntersectionObserver(function(entries){
    entries.forEach(function(entry){
      if(entry.isIntersecting){
        entry.target.classList.add('in-view');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });
  revealEls.forEach(function(el){ observer.observe(el); });
}

// ---------- Init ----------
function init(){
  loadState();
  updateSplitUI();

  if(state.income > 0){
    incomeInput.value = state.income;
    setQuickChipActive(state.income);
    renderResults(false);
    welcomeBack.textContent = 'Welcome back — here\'s your last plan for ' + fmt(state.income) + '.';
    welcomeBack.classList.add('show');
  }

  initGrow();
  handleNavScroll();
  handleBackToCalcVisibility();
  handleSpy();
  initScrollReveal();
}

init();


/* =====================================================================
   MONEY FRIEND — small helper chat. Ready-made advice + keyword matching.
   No live AI, no server, no chat history saved. Only two optional
   preferences (concern, currency) are kept on this device.
   ===================================================================== */
(function moneyFriend(){
  var fab = document.getElementById('mfFab');
  if (!fab) return;
  var panel = document.getElementById('mfPanel'), closeBtn = document.getElementById('mfClose'),
      body = document.getElementById('mfBody'), log = document.getElementById('mfLog'),
      form = document.getElementById('mfForm'), input = document.getElementById('mfInput'),
      sendBtn = document.getElementById('mfSend'), chipsBox = document.getElementById('mfChips'),
      tipText = document.getElementById('mfTipText'), nextTip = document.getElementById('mfNextTip'),
      curSel = document.getElementById('mfCur'), concernBox = document.getElementById('mfConcern');

  var prefs = { concern: '', cur: 'RM' };
  try { var p = JSON.parse(localStorage.getItem('mw_chat_prefs') || '{}'); if (p && typeof p === 'object') { prefs.concern = p.concern || ''; prefs.cur = (p.cur === undefined ? 'RM' : p.cur); } } catch (e) {}
  function savePrefs(){ try { localStorage.setItem('mw_chat_prefs', JSON.stringify(prefs)); } catch (e) {} }
  function c(n){ return prefs.cur + n; }

  /* ---------- the advice (five lessons, written as short chat answers) ---------- */
  var TOPICS = {
    food: {
      keys: ['food','eat','eating','meal','meals','cook','cooking','restaurant','delivery','takeaway','takeout','lunch','dinner','hungry','cafe','order'],
      answer: function(){ return {
        situation: "You don't need to stop eating out. The problem is the night you're tired, the fridge holds mustard and one suspicious cucumber, and delivery is two taps away.",
        insight: "Convenience becomes expensive when you pay for it every single day. Most “I had to order” moments are really “nothing easy was at home”.",
        steps: ["Pick three meals you can make fast (pasta, eggs and rice, soup, a frozen meal you actually like).","Keep their ingredients at home.","Decide which meals out are truly worth it: the friends, the place, the occasion."],
        example: "Tired after class, you can have pasta in 12 minutes. That is cheaper than delivery, and you still go out on Friday because you want to.",
        takeaway: "The goal isn't to make eating out forbidden. It's to make it a choice.",
        follow: ["Make me a shopping list","Give me one money challenge for today"] }; }
    },
    list: {
      keys: ['shopping list','grocery','groceries','supermarket','store','mall','shopping','list','market'],
      answer: function(){ return {
        situation: "You went in for pasta and left with snacks, a candle and something you can't remember buying.",
        insight: "Without a plan, every shelf is a small invitation. The store is designed that way, and it's not a flaw in you.",
        steps: ["Check what you already have at home.","Write down what you actually need.","Set a limit you're comfortable with. Eat first if you can, since hungry shopping adds items."],
        example: "A five-line list and a " + c(40) + " limit turns “quick trip” into “quick trip”, and nothing extra tags along.",
        takeaway: "Decide at home, not at the shelf.",
        follow: ["Help me stop impulse buying","How can I save money on food?"] }; }
    },
    wait: {
      keys: ['impulse','impulsive','stop impulse','buying','buy','cart','online','wait','sale','discount','temptation','tempted','want it','haul','checkout','treat'],
      answer: function(){ return {
        situation: "It's 11pm, the cart is full, and that jacket feels like a personality upgrade.",
        insight: "Wanting something feels urgent in the moment, then fades. A gap between “I want it” and “I paid for it” lets the feeling cool down.",
        steps: ["Small, nonessential item: wait 24 hours.","Bigger purchase: wait a few days or longer, depending on the cost.","Put it in the cart, close the tab, and come back later."],
        example: "If tomorrow you still want it and it fits your budget, buy it with a clear head. If you forgot it, you just kept the money.",
        takeaway: "You don't always have to say no. Sometimes the answer is simply: not now.",
        note: "This is for things you want, not things you need. Urgent essentials like medicine, a broken fridge or school supplies shouldn't wait.",
        follow: ["Make me a shopping list","What small expenses can I reduce?"] }; }
    },
    small: {
      keys: ['small expense','small expenses','small','daily','water','bottle','coffee','snack','snacks','umbrella','charger','prepare','forgot','forget','drinks','little things','leak','reduce'],
      answer: function(){ return {
        situation: "Bottled water, a coffee, a snack, a phone charger, an umbrella when it suddenly rains. Each one is small, and each one felt fine.",
        insight: "These add up because they're forgettable, and they usually happen when we leave home unprepared. Occasional buys are completely normal.",
        steps: ["Before you leave, run a 5-second check: water bottle, keys, phone, charger if needed.","Keep a small snack and umbrella in your bag.","Buy the rest on purpose, not because you ran out."],
        example: "A " + c(3) + " bottle each school day is roughly " + c(60) + " a month. Filling one at home takes ten seconds.",
        takeaway: "Pay for convenience when you choose to, not because you forgot.",
        follow: ["Repair or replace?","Give me one money challenge for today"] }; }
    },
    repair: {
      keys: ['repair','fix','broken','replace','replacement','button','tear','torn','shoes','shoe','zip','worn','old phone','throw away'],
      answer: function(){ return {
        situation: "A button falls off, a seam splits, or the shoe sole starts to peel. The quick thought is “time for a new one”.",
        insight: "Replacing feels easier than fixing, but a small fix often gives an item months or years more.",
        steps: ["Change your first question from “What should I replace this with?” to “Can this be fixed?”","Try simple fixes yourself (sew a button, patch a small tear).","Ask a repair shop what it would cost before you decide."],
        example: "Sewing a button takes five minutes. A tailor or shoe repairer may cost far less than a new pair.",
        takeaway: "Ask “Can this be fixed?” before “What should I buy?”",
        note: "Skip repairs that are unsafe (like electrics or helmets) or cost more than the item is worth. Replacing is fine then.",
        follow: ["What small expenses can I reduce?","Give me one money challenge for today"] }; }
    },
    free: {
      keys: ['restricted','restrict','restriction','boring','enjoy','fun','deprived','miserable','without giving','spend less','spend less without','less without','feeling restricted','guilt','guilty'],
      answer: function(){ return {
        situation: "You try to “be good with money”, cut everything, last four days, then spend double to celebrate.",
        insight: "Strict rules rarely last. Spending sticks better when you protect what you love and trim what you barely notice.",
        steps: ["Pick one or two things you'd hate to give up and keep them.","Find one habit you do on autopilot (daily delivery, impulse add-ons) and make it a little harder.","Give yourself a small “no questions asked” fun amount."],
        example: "Keep Friday dinner out with friends. Skip the Tuesday delivery you ordered only because you were tired.",
        takeaway: "Spend on purpose, save without suffering, and keep the fun that's worth it.",
        follow: ["How can I save money on food?","Help me stop impulse buying"] }; }
    },
    goal: {
      keys: ['goal','save for','saving for','saving','save','emergency','laptop','trip','savings','future'],
      answer: function(){ return {
        situation: "You want to save for something (a laptop, a trip, a cushion for emergencies) but the money keeps disappearing.",
        insight: "Saving is easier when it's tied to something real and decided before you spend, not what's left at the end.",
        steps: ["Name the goal and a rough amount (it can be a guess).","Set aside a small amount first, even " + c(10) + ", then spend the rest.","Use the “wait” rule on impulse buys so more of it stays put."],
        example: "A " + c(25) + " weekly set-aside is about " + c(100) + " a month. Small, steady and doable.",
        takeaway: "Pay your goal first. Even a little counts.",
        extra: "Your plan on this site shows how much is left each month: <a href=\"#calculator\">make or open your plan</a>.",
        follow: ["Help me stop impulse buying","Give me one money challenge for today"] }; }
    },
    tight: {
      keys: ['broke','cant afford',"can't afford",'no money','low income','tight','struggling','poor','not enough','debt','paycheck'],
      answer: function(){ return {
        situation: "Money is tight, and advice like “just skip coffee” can sound a bit out of touch.",
        insight: "You're right: small habits can help, but they don't solve everything. Essentials come first, and the numbers aren't a verdict on you.",
        steps: ["Cover essentials first (food, housing, transport, medicine).","Look for one low-effort change that doesn't cut something important.","If bills are piling up, talk to your provider or a local support service about options."],
        example: "Free changes count too: a shopping list, a 24-hour wait on a want, and carrying water.",
        takeaway: "Small steps help, but you don't have to fix everything today.",
        follow: ["Give me one money challenge for today","How can I save money on food?"] }; }
    }
  };

  var CHALLENGES = [
    "Plan tomorrow's meals. Even a rough idea (what, where, how) is enough.",
    "Write a shopping list before your next trip, and check your kitchen first.",
    "Put one nonessential thing in a cart or note, and wait 24 hours before buying it.",
    "Bring water from home today, and note how it feels.",
    "Find one item that might be worth repairing, and ask “Can this be fixed?”",
    "Before leaving home, run the check: water, keys, phone, charger.",
    "Choose three simple meals you'd actually enjoy and see which ingredients you already have."
  ];
  var DAILY = [
    "Convenience becomes expensive when you pay for it every single day.",
    "Write the shopping list at home, not at the shelf.",
    "You don't always have to say no. Sometimes the answer is simply: not now.",
    "Before you leave: water bottle, keys, phone, charger if needed.",
    "Ask “Can this be fixed?” before “What should I replace this with?”",
    "Keep ingredients for three easy meals and your “tired night” has a cheaper option.",
    "The goal isn't to stop enjoying things. It's to choose them on purpose."
  ];
  var CONCERN_TIP = {
    food: "Since food is on your mind: keep ingredients for three easy meals at home.",
    shopping: "Since impulse buys are your thing: try the 24-hour wait on small wants.",
    small: "Since small daily buys are the leak: run the before-you-leave check (water, keys, phone, charger).",
    goal: "Since you're saving for a goal: set aside a small amount first, then spend the rest."
  };
  var SUGGESTED = ["How can I save money on food?","Help me stop impulse buying","What small expenses can I reduce?","How can I spend less without feeling restricted?","Give me one money challenge for today"];

  function esc(s){ return String(s).replace(/[&<>"']/g, function(ch){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]; }); }

  /* ---------- matching ---------- */
  function norm(t){ return ' ' + t.toLowerCase().replace(/[^a-z0-9£€$' ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' '; }
  function pick(q){
    var t = norm(q), best = null, bestScore = 0;
    Object.keys(TOPICS).forEach(function(k){
      var score = 0;
      TOPICS[k].keys.forEach(function(w){
        var needle = ' ' + w.toLowerCase().replace(/'/g, "'") + ' ';
        if (t.indexOf(needle) > -1 || (w.length > 4 && t.indexOf(w.toLowerCase()) > -1)) score += w.length;
      });
      if (score > bestScore){ bestScore = score; best = k; }
    });
    return best;
  }

  /* ---------- rendering ---------- */
  var lastChallenge = -1, tipIdx = 0, busy = false;
  function addMsg(who, html, cls){
    var d = document.createElement('div');
    d.className = 'mf-msg ' + (who === 'user' ? 'mf-user' : 'mf-bot') + (cls ? ' ' + cls : '');
    d.innerHTML = html;
    log.appendChild(d);
    scrollEnd();
    return d;
  }
  function scrollEnd(){ body.scrollTop = body.scrollHeight; }
  function followHtml(list){
    return '<div class="mf-chips mf-follow">' + list.map(function(f){ return '<button type="button" data-q="' + esc(f) + '">' + esc(f) + '</button>'; }).join('') + '</div>';
  }
  function answerHtml(a){
    var h = '<p>' + esc(a.situation) + '</p><p>' + esc(a.insight) + '</p><p>Try this:</p><ol>' +
      a.steps.map(function(s){ return '<li>' + esc(s) + '</li>'; }).join('') + '</ol><p>For example: ' + esc(a.example) + '</p>';
    if (a.note) h += '<p><em>' + esc(a.note) + '</em></p>';
    if (a.extra) h += '<p>' + a.extra + '</p>';
    if (prefs.concern && CONCERN_TIP[prefs.concern]) h += '<p>' + esc(CONCERN_TIP[prefs.concern]) + '</p>';
    h += '<p class="mf-take">' + esc(a.takeaway) + '</p>' + followHtml(a.follow || []);
    return h;
  }

  function reply(q){
    var t = norm(q);
    // never take sensitive data
    if (/ (password|passcode|pin|cvv|card number|credit card|debit card|account number|otp) /.test(t))
      return '<p>Please don\'t share passwords, card numbers or bank details here. I never need them, and I can\'t keep them safe.</p><p>Tell me what you\'re trying to spend less on instead.</p>' + followHtml(SUGGESTED.slice(0,2));
    if (/ (hi|hello|hey|salam|assalamualaikum|yo) /.test(t) && t.split(' ').length < 6)
      return '<p>Hey! I\'m your Money Friend. Ask me about food, impulse buys, small daily costs, or getting through the month without making life boring.</p>' + followHtml(SUGGESTED.slice(0,3));
    if (/ (thanks|thank you|thx|shukran|ok thanks) /.test(t))
      return '<p>Anytime. Pick one tiny thing from today and leave the rest for later.</p>' + followHtml(["Give me one money challenge for today"]);
    if (/ (are you (an? )?(ai|bot|real|human)|who are you|what are you|chatgpt|openai) /.test(t))
      return '<p>I\'m a small helper built into MoneyWise. I answer from ready-made tips about everyday spending, not from a live AI, so I stick to my five lessons: eating at home, shopping lists, waiting before buying, bringing what you need, and repairing before replacing.</p>' + followHtml(SUGGESTED.slice(0,3));
    if (/ (challenge|dare|task for today|something to do) /.test(t)) return challengeHtml();
    if (/ (another tip|more tips|next tip|tip) /.test(t) && !pick(q)) return '<p class="mf-take">' + esc(nextDaily()) + '</p>' + followHtml(["Another tip","Give me one money challenge for today"]);
    var k = pick(q);
    if (k) return answerHtml(TOPICS[k].answer());
    return '<p>I don\'t have a good answer for that one yet. I\'m best with everyday spending habits.</p><p>Try one of these:</p>' + followHtml(SUGGESTED.slice(0,4));
  }
  function challengeHtml(){
    var i; do { i = Math.floor(Math.random() * CHALLENGES.length); } while (i === lastChallenge && CHALLENGES.length > 1);
    lastChallenge = i;
    return '<p><strong>Today\'s challenge</strong></p><p>' + esc(CHALLENGES[i]) + '</p><p class="mf-take">One small action beats a perfect plan.</p>' + followHtml(["Another challenge","How can I save money on food?"]);
  }
  function nextDaily(){ tipIdx = (tipIdx + 1) % DAILY.length; return DAILY[tipIdx]; }

  function ask(q){
    q = (q || '').trim();
    if (!q || busy) return;
    if (q === 'Another challenge') q = 'Give me one money challenge for today';
    addMsg('user', esc(q));
    busy = true; sendBtn.disabled = true;
    var typing = addMsg('bot', '<span class="mf-typing" aria-label="Typing"><i></i><i></i><i></i></span>', 'mf-typing-wrap');
    setTimeout(function(){
      var html;
      try { html = reply(q); } catch (e) { html = null; }
      typing.remove();
      if (html) addMsg('bot', html);
      else addMsg('bot', '<p>Hmm, something went wrong on my side. Please try that again, or pick one of the suggestions.</p>', 'mf-error');
      busy = false; sendBtn.disabled = false;
      document.getElementById('mfSuggest').style.display = 'none';
    }, 450);
  }

  /* ---------- open / close ---------- */
  function open(){
    panel.hidden = false; panel.classList.remove('closing');
    fab.setAttribute('aria-expanded', 'true');
    fab.style.display = window.matchMedia('(max-width: 620px)').matches ? 'none' : '';
    setTimeout(function(){ input.focus({preventScroll:true}); }, 60);
  }
  function close(){
    panel.classList.add('closing');
    fab.setAttribute('aria-expanded', 'false'); fab.style.display = '';
    setTimeout(function(){ panel.hidden = true; panel.classList.remove('closing'); }, 170);
    fab.focus();
  }
  fab.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && !panel.hidden) close(); });

  form.addEventListener('submit', function(e){ e.preventDefault(); var v = input.value; input.value = ''; ask(v); });
  panel.addEventListener('click', function(e){
    var b = e.target.closest('button[data-q]');
    if (b) ask(b.getAttribute('data-q'));
  });
  nextTip.addEventListener('click', function(){ tipText.textContent = nextDaily(); });

  /* ---------- build the pieces ---------- */
  SUGGESTED.forEach(function(s){
    var b = document.createElement('button'); b.type = 'button'; b.setAttribute('data-q', s); b.textContent = s; chipsBox.appendChild(b);
  });
  tipIdx = Math.floor(Date.now() / 86400000) % DAILY.length;
  tipText.textContent = DAILY[tipIdx];

  curSel.value = prefs.cur;
  curSel.addEventListener('change', function(){ prefs.cur = curSel.value; savePrefs(); });
  Array.prototype.forEach.call(concernBox.querySelectorAll('button'), function(b){
    function paint(){ b.setAttribute('aria-pressed', prefs.concern === b.getAttribute('data-concern') ? 'true' : 'false'); }
    paint();
    b.addEventListener('click', function(){
      prefs.concern = (prefs.concern === b.getAttribute('data-concern')) ? '' : b.getAttribute('data-concern');
      savePrefs();
      Array.prototype.forEach.call(concernBox.querySelectorAll('button'), function(x){ x.setAttribute('aria-pressed', prefs.concern === x.getAttribute('data-concern') ? 'true' : 'false'); });
      if (prefs.concern) tipText.textContent = CONCERN_TIP[prefs.concern];
    });
  });
  if (prefs.concern && CONCERN_TIP[prefs.concern]) tipText.textContent = CONCERN_TIP[prefs.concern];
})();
