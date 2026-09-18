# İzofleks İş Takibi — Kurulum

Telefona ve bilgisayara kurulabilen (PWA), ikonu ana ekranda görünen iş takip uygulaması.

Üç adım var. **1. adımdan sonra uygulama zaten çalışır** (yerel modda), 2. adım telefon–bilgisayar
senkronunu açar, 3. adım telefona kurulumdur.

---

## 1. Yayınlama — GitHub Pages

1. [github.com](https://github.com) → giriş yap (hesabın yoksa ücretsiz aç).
2. Sağ üst **+** → **New repository**
   - **Repository name:** `izofleks-takip`
   - **Public** seçili olsun (Pages ücretsiz katmanda public repo ister)
   - **Create repository**
3. Açılan sayfada **uploading an existing file** bağlantısına tıkla.
4. `izofleks-takip` klasörünün **içindeki** her şeyi (index.html, app.js, app.css,
   firebase-config.js, sw.js, manifest.webmanifest, `icons` klasörü, `.nojekyll`)
   sürükle-bırak. → **Commit changes**
5. Repo içinde **Settings** → sol menüde **Pages**
   - **Source:** `Deploy from a branch`
   - **Branch:** `main` / `/ (root)` → **Save**
6. 1–2 dakika sonra sayfanın üstünde adres çıkar:
   `https://<kullanıcı-adın>.github.io/izofleks-takip/`

> **Kendi alan adın:** `is.izofleks.com.tr` gibi bir alt alan adı bağlanabilir.
> Wix DNS panelinde `is` için CNAME kaydı → `<kullanıcı-adın>.github.io`, sonra
> GitHub Pages ayarlarında **Custom domain** kutusuna `is.izofleks.com.tr` yaz.

---

## 2. Senkron — Firebase Firestore

Bu adımı atlarsan uygulama çalışır ama veriler **sadece o cihazda** kalır.

### 2.1 Proje aç
1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project**
   - Ad: `izofleks-takip` · Google Analytics: **kapalı** (gerekmez)

### 2.2 Giriş yöntemini aç
2. Sol menü **Build → Authentication** → **Get started**
3. **Sign-in method** sekmesi → **Email/Password** → **Enable** → **Save**

### 2.3 Veritabanını aç
4. Sol menü **Build → Firestore Database** → **Create database**
   - Konum: `eur3 (europe-west)` · Mod: **Production mode**
5. **Rules** sekmesine geç, içeriği tamamen sil ve şunu yapıştır → **Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

> Bu kural: herkes yalnızca **kendi** verisini okuyup yazabilir. Adresi bilen biri
> siteyi açsa bile senin listeni göremez.

### 2.4 Ayarları uygulamaya yapıştır
6. Sol üst ⚙ **Project settings** → aşağıda **Your apps** → **Web** simgesi `</>`
   - App nickname: `takip` → **Register app**
7. Çıkan `firebaseConfig` bloğundaki değerleri `firebase-config.js` dosyasındaki
   tırnakların arasına yapıştır:

```js
window.IZO_FIREBASE = {
  apiKey: "AIza...",
  authDomain: "izofleks-takip.firebaseapp.com",
  projectId: "izofleks-takip",
  storageBucket: "izofleks-takip.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

8. Güncellenmiş `firebase-config.js` dosyasını GitHub'da repoya yükle
   (dosyaya tıkla → kalem simgesi → yapıştır → Commit).
9. Uygulamayı aç → sağ üstteki **senkron** düğmesine bas → e-posta + parola yaz →
   **Hesap oluştur**. Diğer cihazlarda **Giriş yap** de.

> Bu bilgiler (apiKey vb.) gizli değildir, herkese açık olması normaldir —
> güvenliği yukarıdaki Firestore kuralları sağlar.

---

## 3. Telefona / bilgisayara kurulum

**Android (Chrome):** siteyi aç → üstteki **Ana ekrana ekle** düğmesi,
ya da ⋮ menü → *Uygulamayı yükle*.

**iPhone (Safari):** siteyi aç → alttaki **Paylaş** → **Ana Ekrana Ekle**.
(iOS'ta yalnızca Safari'den kurulur, Chrome'dan olmaz.)

**Windows / Mac (Chrome, Edge):** adres çubuğunun sağındaki **yükle** simgesi,
ya da üstteki **Ana ekrana ekle** düğmesi. Uygulama kendi penceresinde açılır,
görev çubuğuna sabitlenebilir.

Kurulumdan sonra ikon ana ekranda **iz** işaretiyle görünür; internet yokken de
açılır, girilen kayıtlar bağlantı gelince senkron olur.

---

## Güncelleme

Herhangi bir dosyayı GitHub'da değiştirip commit etmek yeterli — açık uygulamalar
bir sonraki açılışta yeni sürümü alır. Büyük değişikliklerde `sw.js` içindeki
`CACHE = 'izo-takip-v1'` satırındaki numarayı artır (`v2`, `v3` …), böylece eski
önbellek temizlenir.

---

## Dosyalar

| Dosya | Ne işe yarar |
|---|---|
| `index.html` | Sayfa iskeleti |
| `app.css` | Görünüm (açık/koyu tema) |
| `app.js` | Tüm uygulama mantığı + `window.IzoTodo` (A42 arayüzü) |
| `firebase-config.js` | **Senin dolduracağın** senkron ayarları |
| `sw.js` | Çevrimdışı çalışma (service worker) |
| `manifest.webmanifest` | Uygulama adı, ikonlar, kurulum bilgisi |
| `icons/` | Ana ekran ikonları (İzofleks logosundan üretildi) |
| `.nojekyll` | GitHub Pages'in dosyaları olduğu gibi yayınlaması için |

### A42 entegrasyonu
`app.js` sonundaki `window.IzoTodo` arayüzü: `addJob(müşteri, proje)`,
`addTask(jobId, metin, gün)`, `exportData()`. Veri katmanı `localStore()` /
`firestoreStore()` adaptörleriyle ayrılmış — A42 widget'ına taşırken yalnızca
depo adaptörünü değiştirmen yeterli.
