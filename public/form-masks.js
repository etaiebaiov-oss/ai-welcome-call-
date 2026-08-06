// Live input masks for the welcome-call intake form, shared by the admin
// dashboard modal and the designer console. The rep types digits only; the
// dollar sign and percent sign are applied as they type so the value always
// reads the way it should appear in the agreement.

// Digits with at most one decimal point, optionally capped to N decimals.
function digitsOnly(value, maxDecimals) {
  let cleaned = String(value).replace(/[^0-9.]/g, '');
  const parts = cleaned.split('.');
  if (parts.length > 2) cleaned = parts[0] + '.' + parts.slice(1).join('');
  if (maxDecimals !== undefined) {
    const [whole, fraction] = cleaned.split('.');
    if (fraction !== undefined) cleaned = whole + '.' + fraction.slice(0, maxDecimals);
  }
  return cleaned;
}

// Keeps the caret off the end when the mask adds a trailing character,
// otherwise typing "12" then "%" would push the cursor past the symbol.
function setCaret(el, offsetFromEnd) {
  const pos = Math.max(0, el.value.length - offsetFromEnd);
  try {
    el.setSelectionRange(pos, pos);
  } catch (err) {
    /* inputs that don't support selection ranges */
  }
}

function maskCurrency(el) {
  if (!el) return;
  el.setAttribute('inputmode', 'decimal');
  el.addEventListener('input', () => {
    const digits = digitsOnly(el.value, 2);
    el.value = digits ? '$' + digits : '';
    setCaret(el, 0);
  });
  // Settle to a proper two-decimal amount once they move on.
  const settle = () => {
    const digits = digitsOnly(el.value, 2);
    const amount = parseFloat(digits);
    el.value =
      digits && !isNaN(amount)
        ? '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : '';
  };
  el.addEventListener('blur', settle);
  const form = el.closest('form');
  if (form) form.addEventListener('submit', settle);
}

function maskPercent(el) {
  if (!el) return;
  el.setAttribute('inputmode', 'decimal');
  el.addEventListener('input', () => {
    const digits = digitsOnly(el.value);
    el.value = digits ? digits + '%' : '';
    setCaret(el, 1);
  });
  // Clicking into the field should land before the % rather than after it.
  el.addEventListener('focus', () => {
    if (el.value.endsWith('%')) setCaret(el, 1);
  });
}

document.querySelectorAll('[data-mask="currency"]').forEach(maskCurrency);
document.querySelectorAll('[data-mask="percent"]').forEach(maskPercent);
