async function login(pw) {
  if (!pw) pw = document.getElementById('pw').value;
  if (!pw) return;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw })
  });
  if (res.ok) {
    const { token } = await res.json();
    document.cookie = 'session=' + token + '; path=/; max-age=86400; SameSite=Strict';
    localStorage.setItem('botpw', pw);
    location.reload();
  } else {
    localStorage.removeItem('botpw');
    const err = document.getElementById('err');
    err.textContent = 'Доступ запрещен. Неверный пароль.';
    setTimeout(() => err.textContent = '', 3000);
    const pwEl = document.getElementById('pw');
    if (pwEl) { pwEl.value = ''; pwEl.focus(); }
  }
}

// Автологін при відкритті сторінки
(async () => {
  const saved = localStorage.getItem('botpw');
  if (saved) {
    document.getElementById('err').textContent = 'Вхід...';
    await login(saved);
  } else {
    document.getElementById('pw').focus();
  }
})();
