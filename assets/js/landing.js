import { hydrateIcons, icon, toggleTheme } from './icons.js';
import { kv } from './store.js';

hydrateIcons();
document.querySelectorAll('.js-year').forEach(el => (el.textContent = new Date().getFullYear()));

// Theme toggle
const themeBtn = document.getElementById('themeBtn');
const syncThemeIcon = () => (themeBtn.innerHTML = icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'));
syncThemeIcon();
themeBtn.addEventListener('click', () => { toggleTheme(); syncThemeIcon(); });

// Mobile nav
const navLinks = document.getElementById('navLinks');
document.getElementById('navToggle').addEventListener('click', () => navLinks.classList.toggle('open'));
navLinks.addEventListener('click', e => { if (e.target.closest('a')) navLinks.classList.remove('open'); });

// Nav border on scroll
const nav = document.getElementById('nav');
const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// Reveal on scroll
const io = new IntersectionObserver(entries => {
  entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach(el => io.observe(el));

// Hero dropzone → hand the file to the editor through IndexedDB
const drop = document.getElementById('heroDrop');
const input = document.getElementById('heroFile');

async function openInEditor(file) {
  if (!file || !(file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) {
    alert('Please choose a PDF file.');
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  await kv.set('pending', { name: file.name, bytes });
  location.href = 'app.html?open=pending';
}

input.addEventListener('change', () => openInEditor(input.files[0]));
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));
drop.addEventListener('drop', e => openInEditor(e.dataTransfer.files[0]));
