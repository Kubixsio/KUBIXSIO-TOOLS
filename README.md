# KUBIXSIO TOOLS 0.0.1

Ocena AI analizuje całą miniaturkę i zwraca ocenę, krótkie podsumowanie, mocne strony oraz 0–7 potrzebnych poprawek z instrukcjami Photopea. Przycisk ZROBIONE oznacza próbę wykonania porady; PORZUĆ zapisuje odrzuconą poradę także dla kolejnych reanaliz. Karty pozostają widoczne do otrzymania nowego poprawnego wyniku.

Każda analiza pobiera świeży PNG. Reanaliza przesyła również poprzedni oceniony PNG, poprzedni wynik, statusy poprawek i uwagi. Zmiana dokumentu rozpoczyna czystą sesję. Błędny klucz, błąd sieci lub niepoprawna odpowiedź nie usuwają podglądu ani wyniku bieżącej sesji. IndexedDB przechowuje sesję oraz prywatny klucz w kontekście osadzonego panelu Photopea. Sesja nie odtwarza danych poprzedniej funkcji.

## Pliki

- `ai-review.js`: panel, karty, statusy, żądania i reanaliza.
- `ai-review-session.js`: eksport PNG, identyfikacja dokumentu, sesja, IndexedDB i wspólna blokada eksportu chroniąca ASSETS.
- `ai-review-contract.js`: walidacja wyniku i schemat structured output wspólny dla panelu i Workera.
- `ai-review.css`: wygląd panelu.
- `ai-review-config.js`: adres istniejącego właściwego Workera.
- `worker/ai-review-worker.mjs`: prywatny dostęp, CORS, limity, walidacja PNG i OpenAI Responses API.
- `worker/migrations/001-ai-review.sql`: trwałe liczniki w istniejącej bazie; przeniesienie wcześniejszego zużycia.

ASSETS, obróbka postaci, efekty i folderowanie zachowują dotychczasowe pliki. `index.html`, `latest.html` i `photopea.html` prowadzą do jednej wersji pluginu.

## Testy offline

Node.js 22.13+ i zależności developerskie:

```sh
npm install
npx playwright install chromium
npm test
npm run build
```

Można użyć istniejącej przeglądarki Chromium przez zmienną `KTX_TEST_BROWSER` wskazującą jej plik wykonywalny. Testy używają lokalnych danych testowych i SQLite; nie wysyłają żądań do OpenAI ani Cloudflare. Test panelu zapisuje obraz do `test-results/ai-review.png`.

## Uruchomienie właściwego Workera

Nie powstaje drugi Worker ani druga baza. Zachowany adres istniejącego Workera i nazwa istniejącej bazy są identyfikatorami zasobów Cloudflare, a nie trybem działania pluginu.

1. Wyłączyć płatne AI w starym, nieużywanym backendzie przed przeniesieniem liczników. Nie usuwać bazy.
2. W istniejącej bazie wykonać `worker/migrations/001-ai-review.sql`. Migracja nie usuwa ani nie zmienia dotychczasowych tabel; kopiuje wyłącznie identyfikatory i daty prób, bez obrazów, uwag, wyników i sekretów.
3. Do właściwego Workera podpiąć tę samą bazę jako `REVIEW_DB`.
4. Właściwy Worker wymaga sekretów `AI_ACCESS_KEY` (32–512 znaków ASCII bez spacji) oraz `OPENAI_API_KEY`. Sekrety należy wpisać bezpośrednio w Cloudflare, nigdy w kodzie pluginu ani repozytorium.
5. `ALLOWED_ORIGINS`: `https://kubixsio.github.io`. Jeśli ustawiono `OPENAI_MODEL`, musi pozostać `gpt-4.1-mini-2025-04-14`.
6. `npm run build` tworzy pojedynczy plik ES Module `build/worker.mjs` do istniejącego Workera. Opublikować go wraz z nowym frontendem.

Limity: 5 prób dziennie i 50 miesięcznie według UTC; 6 żądań dostępu na minutę i 60 globalnie; żądanie 16 MiB łącznie z oboma PNG. PNG: maksymalnie 4096 px na bok i 8 388 608 pikseli. Rezerwacja próby jest atomowa i następuje przed połączeniem z OpenAI. Nieudana lub niepełna odpowiedź też zużywa próbę; nie ma automatycznego ponawiania. OpenAI ma limit 4000 tokenów odpowiedzi i 35 sekund. Liczniki serwera nie przechowują obrazów, treści uwag ani prywatnych kluczy.

Schemat JSON używa [oficjalnego structured output](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses), a obrazy są przekazywane jako [pełne dane PNG](https://developers.openai.com/api/docs/guides/images-vision).

## Krótki test w Photopea po publikacji

Otworzyć miniaturkę, połączyć dostęp prywatnym kluczem, kliknąć ANALIZUJ, rozwinąć INSTRUKCJA, oznaczyć jedną poradę jako ZROBIONE, inną jako PORZUĆ, wykonać zmianę w grafice i kliknąć ANALIZUJ PONOWNIE. Sprawdzić nową ocenę oraz nowe karty. Jeśli wynik nie wymaga zmian, powinien pojawić się komunikat „Brak koniecznych poprawek”. Test wykonuje płatne analizy i zużywa dwa miejsca w limicie.

Na przyszłość pozostają: Dopytaj AI, automatyczne Poprawki AI, panel zasad stylu oraz biblioteka najlepszych miniaturek.
