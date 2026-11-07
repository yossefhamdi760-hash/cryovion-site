/* Cryovion backend patch: يُحمَّل بعد سكربت الصفحة الأساسي */
(function () {
  if (!db) { console.error('Supabase غير متاح'); return; }
  const COLS = 'id,cat,spec_key,name,spec,bio,bio_ts,photo_url,addr,hours,lamp_mode,phone,is_verified,ref_count,status,created_at,updated_at';
  const redirect = location.origin + location.pathname;
  let refCache = [];
  const on = (el, ev, fn) => el.addEventListener(ev, async e => { e.preventDefault(); e.stopImmediatePropagation(); try { await fn(e); } catch (err) { console.error(err); toast('حدث خطأ، حاول مرة أخرى'); } }, true);

  // إخفاء فيسبوك مؤقتًا
  $('facebookDirectBtn').classList.add('hidden');

  // ---------- تحميل البيانات ----------
  window.load = async function () {
    const [p, r] = await Promise.all([
      db.from('places').select(COLS).eq('status', 'approved').order('created_at', { ascending: false }),
      db.from('reviews').select('*').eq('status', 'approved')
    ]);
    if (p.error) toast('تعذر تحميل البيانات');
    const revs = r.data || [];
    places = (p.data || []).map(d => {
      const rv = revs.filter(x => x.place_id === d.id), rated = rv.filter(x => x.stars > 0), a = getAvailabilityStatus(d);
      return { ...d, hours: d.hours || 'غير معروف', addr: d.addr || 'غير معروف', bio: d.bio || '', phone: d.phone || null,
        avail_state: a.state, avail_label: a.label, avail_color: a.color, reviews: rv, n: rated.length,
        rate: rated.length ? Math.round(rated.reduce((s, x) => s + x.stars, 0) / rated.length * 10) / 10 : 5,
        updated_date: (d.updated_at || '').slice(0, 10) };
    });
    const { data: { session } } = await db.auth.getSession();
    if (session) {
      const { data: meta } = await db.rpc('my_places_meta');
      (meta || []).forEach(m => { const x = places.find(q => q.id === m.id); if (x) x.owner_email = m.owner_email; });
    }
    refreshUserUI(); render(); renderPostersCarousel();
  };
  window.saveCustomOverride = () => {};

  // ---------- الجلسة والأدمن (من الخادم) ----------
  async function applySession(session) {
    if (!session) {
      adminUnlocked = false;
      if (getCurrentUser()) setCurrentUser(null);
      $('adminLockScreen').classList.remove('hidden'); $('adminDashboardContent').classList.add('hidden');
      return load();
    }
    const u = session.user, md = u.user_metadata || {};
    setCurrentUser({ name: md.name || md.full_name || u.email.split('@')[0], email: u.email, role: md.role || 'مستخدم', provider: u.app_metadata && u.app_metadata.provider });
    const { data } = await db.from('admins').select('user_id').eq('user_id', u.id).maybeSingle();
    adminUnlocked = !!data;
    if (adminUnlocked) {
      const rq = await db.from('ad_requests').select('*').order('created_at', { ascending: false });
      refCache = (rq.data || []).map(x => ({ ...x, desc: x.description, refs: '—' }));
      $('adminLockScreen').classList.add('hidden'); $('adminDashboardContent').classList.remove('hidden');
    }
    await load();
    if (currentViewName === 'admin' && adminUnlocked) renderAdminList();
  }
  db.auth.onAuthStateChange((_e, s) => setTimeout(() => applySession(s), 0));

  // شاشة الأدمن: لا رمز في المتصفح
  $('adminPinInput').classList.add('hidden');
  $('adminLockScreen').querySelector('p').textContent = '🔒 سجّل الدخول بحساب الأدمن';
  $('unlockAdminBtn').textContent = 'تحقق';
  on($('unlockAdminBtn'), 'click', () => toast(adminUnlocked ? 'أنت أدمن' : 'هذا الحساب ليس أدمن'));

  // ---------- تسجيل الدخول ----------
  on($('googleDirectBtn'), 'click', async () => {
    const { error } = await db.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirect } });
    if (error) toast('تعذر الدخول عبر Google');
  });
  on($('accountForm'), 'submit', async () => {
    const email = $('accEmail').value.trim().toLowerCase(), password = $('accPass').value;
    const name = ($('accName').value || '').trim() || email.split('@')[0];
    if (isRegisterMode) {
      const { error } = await db.auth.signUp({ email, password, options: { data: { name, role: selectedRole }, emailRedirectTo: redirect } });
      return toast(error ? error.message : 'تم إرسال رابط التفعيل لبريدك، افتحه ثم سجّل الدخول');
    }
    const { error } = await db.auth.signInWithPassword({ email, password });
    toast(error ? 'بيانات الدخول غير صحيحة أو البريد غير مفعّل' : 'تم تسجيل الدخول');
    if (!error) navigateApp('home');
  });

  // ---------- الصور ----------
  const compress = url => new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => { const k = Math.min(1, 900 / i.width), c = document.createElement('canvas'); c.width = i.width * k; c.height = i.height * k;
      c.getContext('2d').drawImage(i, 0, 0, c.width, c.height); c.toBlob(b => b ? res(b) : rej(), 'image/jpeg', 0.82); };
    i.onerror = rej; i.src = url;
  });
  async function uploadPhoto(dataUrl, uid) {
    const blob = await compress(dataUrl), path = `${uid}/${Date.now()}.jpg`;
    const { error } = await db.storage.from('place-photos').upload(path, blob, { contentType: 'image/jpeg' });
    if (error) throw error;
    return db.storage.from('place-photos').getPublicUrl(path).data.publicUrl;
  }

  // ---------- حفظ الصفحة ----------
  on($('editorForm'), 'submit', async () => {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return toast('سجّل دخولك أولًا');
    const bio = $('edBio').value.trim(), name = $('edName').value.trim();
    if (containsDefamation(bio) || containsDefamation(name)) return toast('🚫 النص يحتوي على عبارات مسيئة.');
    const id = $('edId').value, existing = places.find(x => x.id === id);
    let photo = $('edPhotoUrl').value.trim();
    if (photo.startsWith('data:')) { toast('جاري رفع الصورة...'); photo = await uploadPhoto(photo, session.user.id); }
    const row = {
      cat: $('edCat').value, spec_key: $('edSpecKey').value, name, spec: $('edSpec').value.trim(), bio,
      bio_ts: (!existing || bio !== (existing.bio || '')) ? Date.now() : existing.bio_ts,
      photo_url: photo, addr: $('edAddr').value.trim() || 'غير معروف', lamp_mode: $('edLampMode').value,
      hours: $('edHours').value.trim() || 'غير معروف', phone: $('edPhone').value.trim() || null
    };
    if (adminUnlocked) {
      row.is_verified = $('edIsVerified').checked;
      row.owner_email = $('edOwnerEmail').value.trim().toLowerCase() || null;
      row.ref_count = parseInt($('edRefCount').value, 10) || 0;
    }
    let res, newId = id;
    if (id) res = await db.from('places').update(row).eq('id', id);
    else {
      if (!adminUnlocked) return toast('إضافة الصفحات للأدمن فقط');
      newId = 'c-' + crypto.randomUUID().slice(0, 8);
      res = await db.from('places').insert({ ...row, id: newId, status: 'approved' });
    }
    if (res.error) return toast('رُفض الحفظ: ليست لديك صلاحية أو بيانات غير صالحة');
    closeEditorModal(); await load();
    if (currentViewName === 'placePage') renderPlacePageDOM(newId);
    if (currentViewName === 'admin') renderAdminList();
    if (currentViewName === 'myManaged') renderManagedAds();
    toast('✔ تم حفظ التعديلات بنجاح!');
  });

  window.quickToggleLamp = async id => {
    const p = places.find(x => x.id === id); if (!p) return;
    const order = ['unknown', 'open', 'closed'], next = order[(order.indexOf(p.lamp_mode || 'unknown') + 1) % 3];
    const { error } = await db.from('places').update({ lamp_mode: next }).eq('id', id);
    if (error) return toast('لا تملك صلاحية التعديل');
    await load(); renderManagedAds();
    toast(next === 'open' ? '🟢 مفتوح الآن' : next === 'closed' ? '🔴 مغلق الآن' : '⚪ غير معروف');
  };
  window.deleteAd = async id => {
    if (!confirm('حذف هذه الصفحة نهائيًا؟')) return;
    const { error } = await db.from('places').delete().eq('id', id);
    if (error) return toast('الحذف للأدمن فقط');
    await load(); renderAdminList(); toast('تم الحذف');
  };

  // ---------- طلبات النشر ----------
  window.getRefRequests = () => refCache;
  window.saveRefRequest = async rq => {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return toast('سجّل دخولك أولًا');
    const { error } = await db.from('ad_requests').insert({ user_id: session.user.id, user_name: rq.user_name, user_email: session.user.email,
      title: rq.title, type: rq.type, phone: rq.phone, description: rq.desc });
    if (error) toast('تعذر إرسال الطلب');
  };

  load();
})();
