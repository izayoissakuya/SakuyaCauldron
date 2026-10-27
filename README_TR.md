# Sakuya's Haunted Cauldron

[English](README.md) · **Türkçe**

Twitch chat'iyle oynanan, OBS'e eklenen hafif bir kazan overlay'i. İzleyiciler `!throw` yazarak kazana emoji atar, kazan %100 olunca chat 30 saniye boyunca bir **ceza oylaması** yapar ve kazanan ceza ekranda gösterilir.

## Nasıl çalışır?

1. İzleyici chat'e `!throw` yazar; adı ve emojisi kazana düşer, yüzde artar.
2. Kazan %100 olunca "POTION BREWED!" olayı çıkar ve **ceza oylaması** başlar.
3. Chat, `1`–`5` yazarak oy verir (kişi başı tek oy). Overlay'in sağ üstünde canlı oy sayıları ve geri sayım görünür, bot da seçenekleri chat'e yazar.
4. Süre bitince en çok oy alan ceza ekranda ve chat'te duyurulur. **Eşitlikte** eşit oyu olan seçenekler arasından, **hiç oy yoksa** tüm seçenekler arasından rastgele biri seçilir.
5. Kazan sıfırlanır, yeni tur başlar.

Mimari: Node.js'te tek bir Twitch chat bağlantısı ve yerel bir HTTP sunucusu; overlay olayları Server-Sent Events (SSE) ile alır. Harici yapay zekâ, WebGL veya görüntü işleme yoktur. Sunucu yalnızca `127.0.0.1` adresinde dinler, yerel ağa açılmaz.

## 1. Node.js kurulumu

1. Windows'a **Node.js 22 LTS** kur: [https://nodejs.org/](https://nodejs.org/)
2. Projeyi bir klasöre çıkar.
3. `install.bat` dosyasını çalıştır. Bu, `.env` dosyasını oluşturur ve gereken paketleri yükler.
4. Proje klasöründeki `.env` dosyasını Not Defteri ile aç.

## 2. Twitch uygulaması ve OAuth

Tokenı üçüncü taraf bir sohbete yapıştırmak yerine yerel OAuth girişini kullanıyoruz. Uygulama iki izin ister:

- `chat:read`: `!throw` komutlarını ve oyları okumak için.
- `chat:edit`: botun oylama başlangıcını, sonucu ve bekleme uyarılarını chat'e yazabilmesi için.

Bot, bağladığın hesabın adıyla yazar. Mesajların ayrı bir bot hesabından gelmesini istiyorsan 6. adımda o hesapla giriş yap.

1. [https://dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) sayfasında bir Twitch Developer uygulaması oluştur.
2. OAuth Redirect URL alanına **tam olarak** şu adresi ekle: `http://localhost:3131/auth/callback`
3. Client Type seçeneği varsa **Confidential** seç ve Client ID ile Client Secret değerlerini kopyala.
4. `.env` dosyasında şu alanları doldur:

   ```
   TWITCH_CLIENT_ID=BURAYA_CLIENT_ID
   TWITCH_CLIENT_SECRET=BURAYA_CLIENT_SECRET
   TWITCH_CHANNEL=twitchkanaladin
   ```

   `TWITCH_CHANNEL`, yayın yaptığın kanalın kullanıcı adıdır; URL'de `twitch.tv/` sonrasındaki bölümü yaz, `@` kullanma. `PORT` değerini değiştirmediysen diğer ayarları olduğu gibi bırakabilirsin.
5. `start.bat` dosyasını çalıştır.
6. Tarayıcıda `http://127.0.0.1:3131/setup` adresini aç ve **Twitch hesabını bağla** düğmesine bas. Yetki ekranında `chat:read` ve `chat:edit` izinlerini onayla.
7. Kurulum tamamlandıktan sonra `tokens.json` dosyası yerel olarak oluşur. Bu dosyayı kimseyle paylaşma, ZIP'lere ekleme veya herkese açık bir depoya yükleme. `.gitignore` bu dosyayı zaten hariç tutar.

OAuth redirect adresi Twitch Developer Console'daki adresle bire bir eşleşmelidir. Daha önce yalnızca `chat:read` ile bağlandıysan terminalde `chat:edit` uyarısı görürsün; `/setup` sayfasından hesabı yeniden bağla.

## 3. Overlay'i test et

Node.js uygulaması açıkken şunu aç:

`http://127.0.0.1:3131/overlay?test=1`

Sol üstteki test panelinde:

- **Test !throw**: Sahte bir izleyiciyle atış yapar. On kez basınca kazan dolar ve oylama başlar.
- **Start vote**: Kazanı doldurmadan oylama panelini açar.
- **Test vote**: Sahte bir izleyici adına rastgele bir seçeneğe oy verir.
- **Reset**: Kazanı sıfırlar ve açık oylamayı iptal eder.

Test düğmeleri `?test=1` olmayan OBS adresinde görünmez.

## 4. OBS'ye ekle

1. Önce `start.bat` ile Node.js sunucusunu çalıştır.
2. OBS → Sources → **+** → **Browser**.
3. URL: `http://127.0.0.1:3131/overlay`
4. Width: `1920`, Height: `1080`.
5. Kaynak arka planı transparandır. Browser Source'ın görünür olması için Node.js penceresi çalışır durumda kalmalıdır.

Overlay oylama sırasında yenilenirse panel kaldığı yerden devam eder.

## 5. Chat komutları

| Komut | Ne yapar |
| --- | --- |
| `!throw` | Kazana hediye kutusu (🎁) atar. |
| `!throw dragon`, `!throw pizza` | Kelimeye uyan emojiyi atar (İngilizce anahtar kelimeler). |
| `!throw kedi`, `!throw cadı` | Türkçe kısayollar: kedi, köpek, fare, hayalet, balkabağı, yarasa, örümcek, cadı, hediye, pizza, kalp, ejderha, kurukafa. |
| `!throw 🎃` | Doğrudan yazılan emojiyi atar. |
| `1` … `5` | Oylama açıkken oy verir (kişi başı bir oy). |

Eşleşme bulunamazsa 🎁 düşer.

### Emoji filtresi

Sunucu, ekrana düşecek emojiyi engelli listeyle karşılaştırır; engelliyse atış yine sayılır ama 🎁 düşer. Varsayılan engelli liste: 🍆 🍑 💦 🖕 🔞 👅 💉 💊 🚬. Kendi emojilerini `.env` içindeki `BLOCKED_EMOJIS` satırına yan yana yazarak ekleyebilirsin (örn. `BLOCKED_EMOJIS=🔫🍺`). Varsayılan listeyi değiştirmek istersen `server.js` içindeki `DEFAULT_BLOCKED_EMOJIS` satırını düzenle.

### Bekleme süreleri ve uyarılar

- Aynı kişi iki `!throw` arasında `THROW_COOLDOWN_SECONDS` (varsayılan 120 sn) beklemelidir.
- Herhangi iki atış arasında `GLOBAL_COOLDOWN_SECONDS` (varsayılan 5 sn) ortak bekleme vardır.
- Bot, kişisel beklemeye takılana kalan süreyi chat'e yazar ("you can throw again in 1m 55s"). Chat dolmasın diye aynı kişiye en çok 30 saniyede bir, tüm kanala en çok 3 saniyede bir yazar; ortak beklemede hiç yazmaz. `COOLDOWN_NOTICES=false` ile uyarıları tamamen kapatabilirsin.

## 6. Ceza listesi

Oylamadaki 5 ceza `server.js` içindeki `PUNISHMENTS` listesindedir. Metinleri değiştirebilirsin; seçenek sayısını 5'ten farklı yaparsan chat'teki "1–5" mesajını ve oy kontrolünü de güncellemen gerekir.

## 7. `.env` ayarları

| Ayar | Varsayılan | Açıklama |
| --- | --- | --- |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | – | Twitch Developer uygulaması bilgileri. |
| `TWITCH_CHANNEL` | – | Yayın yaptığın kanalın kullanıcı adı. |
| `PORT` | `3131` | Yerel sunucu portu. Değiştirirsen OAuth Redirect URL'yi de değiştir. |
| `FILL_PER_THROW` | `10` | Her geçerli `!throw` yüzdeyi kaç artırır (10 = 10 atışta dolar). |
| `BREW_RESET_MS` | `4500` | Kazan dolduktan sonra sıfırlanma gecikmesi (ms). |
| `THROW_COOLDOWN_SECONDS` | `120` | Aynı kişinin iki atışı arası bekleme. |
| `GLOBAL_COOLDOWN_SECONDS` | `5` | Herhangi iki atış arası ortak bekleme. |
| `COOLDOWN_NOTICES` | `true` | Botun bekleme uyarılarını yazması. |
| `VOTE_SECONDS` | `30` | Oylama süresi (5–300 sn). |
| `BLOCKED_EMOJIS` | boş | Varsayılana ek engelli emojiler. |

Not: Eski sürümlerdeki `USER_COOLDOWN_SECONDS` ve `HOST` satırları artık kullanılmaz; silebilirsin.

## Dosyalar

- `server.js`: Yerel web sunucusu, Twitch OAuth, chat bağlantısı, `!throw`, emoji filtresi, bekleme süreleri, oylama ve SSE olayları.
- `public/index.html`: Overlay'in HTML yapısı ve görsel katmanlar (kazan, oylama paneli, test paneli).
- `public/style.css`: Şeffaf overlay, kazan ve oylama paneli stilleri, animasyonlar.
- `public/app.js`: Sunucudan olayları alıp emojileri düşürür, yüzdeyi ve oylama panelini günceller.
- `public/assets/`: Kazan GIF'leri (`cauldron-idle`, `cauldron-add`, `reward`, `punishment`).
- `.env`: Yerel gizli bilgiler ve ayarlar (depoya eklenmez).
- `tokens.json`: OAuth tokenları (depoya eklenmez).

## Bilinen eksikler / yapılacaklar

- **Ödül/ceza ayrımı henüz yok.** Kazan dolunca overlay şu an her zaman "reward" GIF'ini ve "REWARD UNLOCKED!" yazısını oynatır, ardından oylama sonucu ceza olarak duyurulur. `punishment.gif` henüz kullanılmıyor.
- Overlay, kazan animasyonu bitince `/api/animation/complete` adresine istek atar; sunucuda bu adres henüz yok (404 döner, zararsızdır, yalnızca tarayıcı konsolunda uyarı görünür).

## Güvenlik notu

Client Secret ve `tokens.json` özel kimlik bilgileridir. Bunları chat'e, ekran görüntüsüne, GitHub'a veya başkalarına gönderme. Sorun olduğunda gizli değerleri paylaşmadan hata mesajını paylaşabilirsin.
