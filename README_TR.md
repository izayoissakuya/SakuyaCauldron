# Sakuya's Haunted Cauldron — ilk sürüm

Bu proje, Twitch chat'inde `!throw` yazıldığında izleyicinin adı ve emojisini kazana düşüren, yüzde göstergesini artıran ve %100'de “POTION BREWED!” olayı gönderen hafif bir Node.js + OBS Browser Source başlangıç projesidir.

**Bu sürüm ödül veya ceza uygulamaz.** Kazan tamamlandığında yalnızca bir tamamlanma olayı üretir ve birkaç saniye sonra yeni tur için sıfırlanır. Ödül/ceza mantığını ve son tasarımdaki cadı/kazan görsellerini sonraki aşamada eklemek üzere ayrı bıraktık.

## Kaynak kullanımı

- Node.js tarafında tek bir Twitch chat bağlantısı ve basit bir yerel HTTP sunucusu çalışır.
- Overlay, sunucudan olayları Server-Sent Events (SSE) ile alır.
- Harici yapay zekâ, video döngüsü, WebGL veya görüntü işleme yoktur.
- Overlay'de aynı anda en fazla 12 düşen emoji tutulur.
- Sunucu yalnızca `127.0.0.1` adresinde dinler; yerel ağa açılmaz.

## 1. Node.js kurulumu

1. Windows'a **Node.js 22 LTS** kur: <https://nodejs.org/>
2. ZIP dosyasını bir klasöre çıkar.
3. `install.bat` dosyasını çalıştır. Bu, `.env` dosyasını oluşturur ve gereken paketi yükler.
4. Proje klasöründeki `.env` dosyasını Not Defteri ile aç.

## 2. Twitch uygulaması ve OAuth

Tokenı üçüncü taraf bir sohbete yapıştırmak yerine yerel OAuth girişini kullanıyoruz. Uygulama yalnızca `chat:read` izni ister; chat'e mesaj göndermez.

1. <https://dev.twitch.tv/console/apps> sayfasında bir Twitch Developer uygulaması oluştur.
2. OAuth Redirect URL alanına **tam olarak** şu adresi ekle: `http://localhost:3131/auth/callback`
3. Client Type seçeneği varsa **Confidential** seç ve Client ID ile Client Secret değerlerini kopyala.
4. `.env` dosyasında şu alanları doldur:

   ```env
   TWITCH_CLIENT_ID=BURAYA_CLIENT_ID
   TWITCH_CLIENT_SECRET=BURAYA_CLIENT_SECRET
   TWITCH_CHANNEL=twitchkanaladin
   ```

   `TWITCH_CHANNEL`, yayın yaptığın kanalın kullanıcı adıdır; URL'de `twitch.tv/` sonrasındaki bölümü yaz, `@` kullanma. `PORT` değerini değiştirmediysen diğer ayarları olduğu gibi bırakabilirsin.

5. `start.bat` dosyasını çalıştır.
6. Tarayıcıda `http://127.0.0.1:3131/setup` adresini aç ve **Twitch hesabını bağla** düğmesine bas. Yetki ekranında sadece chat okuma iznini onayla.
7. Kurulum tamamlandıktan sonra `tokens.json` dosyası yerel olarak oluşur. Bu dosyayı kimseyle paylaşma, ZIP'lere ekleme veya herkese açık bir depoya yükleme. `.gitignore` bu dosyayı zaten hariç tutar.

OAuth redirect adresi Twitch Developer Console'daki adresle bire bir eşleşmelidir. Bağlantı/yenileme sorunlarında terminaldeki hatayı ve `/setup` durumunu kontrol et.

## 3. Overlay'i test et

Node.js uygulaması açıkken şunu aç:

`http://127.0.0.1:3131/overlay?test=1`

Sol üstteki **Test !throw** düğmesine on kez basınca kazan dolar ve “POTION BREWED!” görünür. **Reset** düğmesi kazanı sıfırlar. Test düğmeleri, `?test=1` olmayan OBS adresinde görünmez.

Gerçek chat komutu: `!throw`

İzleyici isterse izin verilen listeden bir emoji de gönderebilir: `!throw 🎃`. Her kullanıcıya varsayılan olarak sabit bir emoji atanır. Kullanıcı başına bekleme süresi `.env` içindeki `USER_COOLDOWN_SECONDS` değeridir.

## 4. OBS'ye ekle

1. Önce `start.bat` ile Node.js sunucusunu çalıştır.
2. OBS → Sources → **+** → **Browser**.
3. URL: `http://127.0.0.1:3131/overlay`
4. Width: `1920`, Height: `1080`.
5. Kaynak arka planı transparandır. Browser Source'ın görünür olması için Node.js penceresi çalışır durumda kalmalıdır.

İlk sürümde cadı ve kazan emoji/CSS ile yer tutucu olarak gösterilir. Daha sonra kendi PNG/SVG görsellerini, animasyonlarını ve son yerleşimi `public/index.html` ile `public/style.css` dosyalarından değiştirebilirsin. Twitch bağlantısını ve oyun mantığını `server.js` yönetir; görsel olayları `public/app.js` dinler.

## 5. `.env` ayarları

- `FILL_PER_THROW=10`: Her geçerli `!throw` yüzdeyi 10 artırır; varsayılan olarak 10 komut bir iksir turunu tamamlar.
- `USER_COOLDOWN_SECONDS=3`: Aynı kullanıcının komutları arasındaki bekleme süresi.
- `BREW_RESET_MS=4500`: İksir tamamlandıktan sonra kazanının sıfırlanma gecikmesi (milisaniye).
- `PORT=3131`: Yerel sunucunun portu. Portu değiştirirsen OAuth Redirect URL'yi de değiştirmen gerekir.

## Dosyalar

- `server.js`: Yerel web sunucusu, Twitch OAuth, chat bağlantısı, `!throw`, yüzde ve SSE olayları.
- `public/index.html`: Overlay'in HTML yapısı ve görsel katmanlar.
- `public/style.css`: Şeffaf overlay, kazan yer tutucusu ve animasyonlar.
- `public/app.js`: Sunucudan olayları alıp emojileri düşürür, yüzdeyi günceller.
- `.env`: Yerel gizli bilgiler ve ayarlar (ZIP'e dahil edilmez).
- `tokens.json`: OAuth tokenları (ZIP'e dahil edilmez).

## Güvenlik notu

Client Secret ve `tokens.json` özel kimlik bilgileridir. Bunları chat'e, ekran görüntüsüne, GitHub'a veya başkalarına gönderme. Sorun olduğunda gizli değerleri paylaşmadan hata mesajını paylaşabilirsin.
