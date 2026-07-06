/**
 * dashboard.js — dashboard-specific JavaScript
 * Chart.js initialization is inline in dashboard/index.ejs for data binding.
 * This file provides shared utilities used across multiple dashboard pages.
 */

// Format rupiah
function formatRupiah(amount) {
  return 'Rp ' + Number(amount).toLocaleString('id-ID');
}

// Copy text to clipboard with toast feedback
function copyToClipboard(text, label) {
  navigator.clipboard.writeText(text).then(() => {
    showToast((label || 'Teks') + ' disalin!', 'success');
  }).catch(() => {
    showToast('Gagal menyalin', 'error');
  });
}

// Toast notification
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  const colorMap = {
    success: 'bg-emerald-700',
    error:   'bg-red-700',
    info:    'bg-blue-700',
  };
  toast.className = `fixed bottom-4 right-4 ${colorMap[type] || 'bg-slate-800'} text-white text-xs px-4 py-2.5 rounded-xl shadow-lg z-50 transition-opacity`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}
