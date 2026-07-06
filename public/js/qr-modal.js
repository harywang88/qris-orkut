/**
 * qr-modal.js — shared QR code modal utility
 * Used across the dashboard to display QR images in a modal overlay.
 */

window.QrModal = {
  show(imageBase64, note, amount) {
    const existing = document.getElementById('__qr-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = '__qr-modal';
    modal.className = 'fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4';
    modal.innerHTML = `
      <div class="bg-white rounded-2xl shadow-2xl p-6 max-w-sm w-full">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-semibold text-slate-800 text-sm">QR Code Pembayaran</h3>
          <button id="__qr-close" class="text-slate-400 hover:text-slate-700 text-xl leading-none">&times;</button>
        </div>
        <div class="text-center">
          <img src="${imageBase64}" alt="QR Code"
               class="mx-auto rounded-xl border border-slate-200 w-64 h-64 object-contain" />
          ${note ? `<p class="text-xs font-mono text-slate-500 mt-3 break-all leading-relaxed">${note}</p>` : ''}
          ${amount ? `<p class="text-lg font-bold text-slate-800 mt-2">${amount}</p>` : ''}
        </div>
        <button id="__qr-close2"
                class="mt-5 w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm rounded-xl transition font-medium">
          Tutup
        </button>
      </div>
    `;

    document.body.appendChild(modal);

    const close = () => modal.remove();
    document.getElementById('__qr-close').addEventListener('click', close);
    document.getElementById('__qr-close2').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', function handler(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', handler); }
    });
  },
};
