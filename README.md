# G-Map Local Extractor — Aplikasi Scraper Google Maps Lokal

Aplikasi web scraper lokal berkinerja tinggi untuk mengumpulkan prospek bisnis (B2B Leads) secara langsung dari Google Maps tanpa batasan pencarian.

## 🚀 Fitur Utama

- **Pencarian Tanpa Batas**: Jalankan scraping prospek bisnis sebanyak yang Anda butuhkan tanpa batasan kuota.
- **Data Prospek Lengkap**: Mengekstrak Nama Bisnis, Kategori, Rating, Jumlah Ulasan, Nomor Telepon, Alamat, Website, dan Jam Operasional.
- **Visualisasi Real-Time**: Dashboard interaktif yang menampilkan proses scraping baris-demi-baris secara langsung.
- **Filter & Urutkan Instan**: Lakukan pencarian kata kunci dan pengurutan data langsung di tabel antarmuka.
- **Ekspor Mudah**: Unduh hasil scraping dalam format CSV atau JSON sekali klik untuk diintegrasikan ke Excel atau Google Sheets.

## 🛠️ Persyaratan Sistem

- **Node.js** (versi 16 atau lebih tinggi)
- **Google Chrome** (terpasang di sistem)

## 📦 Memulai Cepat

### 1. Jalankan Aplikasi
Buka terminal di direktori proyek ini (`c:\laragon\www\google-scrapper`) lalu jalankan perintah:

```bash
npm run dev
```

Server lokal akan langsung aktif dan mendengarkan pada alamat:
👉 **[http://localhost:3000](http://localhost:3000)**

### 2. Gunakan di Browser
1. Buka browser Anda dan navigasikan ke `http://localhost:3000`.
2. Masukkan kata kunci pencarian pada kolom **Search Keyword** (contoh: `Dentist Jakarta` atau `Coffee shops in Cupertino`).
3. Tentukan batas hasil scraping menggunakan slider atau preset angka.
4. Klik **Generate Leads** dan saksikan data masuk secara langsung di tabel.
5. Saring data sesuai kebutuhan lalu klik **Export CSV** untuk mengunduh hasilnya.

## 📂 Struktur File Proyek

- `server.js`: Server web lokal Express yang melayani antarmuka dan menyediakan API streaming.
- `scraper.js`: Mesin scraping menggunakan Puppeteer dengan Stealth plugin untuk simulasi penjelajahan manusia.
- `index.html`: Antarmuka visual dashboard lead generator.
- `index.css`: Gaya tampilan modern dengan tema gelap glassmorphism.
- `app.js`: Kontrol interaktif frontend dan integrasi ekspor data.
- `package.json`: Pengelola dependensi proyek Node.js.

## 📄 Lisensi
MIT License - Bebas digunakan dan dimodifikasi secara personal atau komersial.