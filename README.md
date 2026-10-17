# LumenMail

LumenMail ist ein Windows-E-Mail-Client mit IMAP/SMTP, lokalem Postfach, Entwürfen, Kategorien und einem integrierten ChatGPT-Assistenten.

## Installieren

Für die normale Nutzung brauchst du nur die Windows-Setup-Datei aus dem GitHub-Release:

1. Doppelklicke auf `LumenMail-Setup-1.0.5.exe`.
2. Wähle bei Bedarf den Installationsordner.
3. Lass die Verknüpfung im Startmenü oder auf dem Desktop erstellen.
4. Starte LumenMail und füge dein E-Mail-Konto hinzu.

Der Installer ist ein Windows-Programm-Setup. Node.js brauchst du zum Installieren und Verwenden nicht.

## E-Mail-Konto einrichten

LumenMail verbindet sich mit IMAP zum Empfangen und SMTP zum Versenden. Der Einrichtungsdialog bietet Voreinstellungen für Gmail, T‑Online, iCloud und Outlook sowie eigene Serverdaten.

- **Gmail:** IMAP im Google-Konto aktivieren und ein Google-App-Passwort verwenden. Das normale Kontopasswort wird meist nicht angenommen. Leerzeichen im App-Passwort entfernt LumenMail automatisch.
- **T‑Online:** LumenMail trägt `secureimap.t-online.de:993` und `securesmtp.t-online.de:465` ein. Verwende das Telekom-„Passwort für E‑Mail‑Programme“.
- **iCloud Mail (`@icloud.com`):** LumenMail trägt `imap.mail.me.com:993` und `smtp.mail.me.com:587` ein. Apple verlangt für die Anmeldung in einer Drittanbieter-App ein App-spezifisches Passwort. Erstelle es in deinem Apple Account unter „Anmelden und Sicherheit → App-spezifische Passwörter“.
- **Outlook / Microsoft 365:** Server sind vorausgefüllt. Microsoft verlangt bei vielen Konten OAuth2. LumenMail kann einen gültigen OAuth2-Zugriffstoken verwenden; ein Microsoft-Anmeldefenster ist in dieser Version noch nicht integriert.
- **Andere Anbieter:** IMAP-/SMTP-Adressen, Ports und Anmeldeart beim E-Mail-Anbieter nachsehen.

Diese E-Mail-Anbieter nutzen in LumenMail keinen QR-Geräte-Login. Der QR-/Gerätecode ist nicht für alle Mailanbieter als Desktop-Anmeldung verfügbar. LumenMail öffnet die Anbieter-Voreinstellungen direkt; Passwörter für E-Mail-Programme werden lokal verschlüsselt gespeichert.

Die Zugangsdaten werden mit dem Windows-Schlüsselspeicher verschlüsselt. Verbindungsfehler zeigen Hinweise für Server, Port, TLS und Anmeldung. Beim Speichern prüft LumenMail sowohl den IMAP-Empfang als auch den SMTP-Versand, bevor das Konto übernommen wird. Die Anmeldung bei Gmail, T‑Online und iCloud erfolgt in dieser Version mit dem jeweiligen Passwort/App-Passwort; eine QR-Kopplung ist nicht enthalten.

## ChatGPT und intelligente Sortierung

In **Einstellungen → ChatGPT → Mit ChatGPT verbinden** meldest du dich über den Browser an. Ein API-Schlüssel ist nicht erforderlich. Der offizielle Open-Source-Anmeldeweg kann die im ChatGPT-Tarif enthaltene Nutzung verwenden, wenn dein Konto dafür berechtigt ist. Diese Nutzung zählt zu deinem vorhandenen ChatGPT-Nutzungslimit; sie ist nicht unbegrenzt. LumenMail richtet keine API-Abrechnung ein und verlangt kein API-Guthaben.

Neue E-Mails werden zunächst lokal nach einfachen Regeln sortiert. Wenn du ChatGPT verbindest und **„Neue E-Mails automatisch sortieren“** aktiviert lässt, sendet LumenMail für neu eingegangene Nachrichten Betreff, Absender und Nachrichtentext an ChatGPT, damit ChatGPT die Kategorie und Wichtigkeit bestimmen kann. Die Einstellung ist standardmäßig eingeschaltet, wie gewünscht; ohne ChatGPT-Verbindung werden keine E-Mail-Inhalte für diese KI-Sortierung übertragen. Mit „Sortiere meine E-Mails“ im Assistenten kannst du außerdem die Nachrichten im ausgewählten Posteingang kategorisieren.

Der ChatGPT-Assistent kann E-Mails zusammenfassen, Aufgaben und Termine herausarbeiten, Antwortentwürfe schreiben und Entwürfe professioneller, freundlicher oder fehlerfrei formulieren. Dazu werden die jeweilige E-Mail oder der Entwurf an ChatGPT übermittelt. LumenMail liest keine ChatGPT-Unterhaltungen oder den ChatGPT-Verlauf aus.

Für die Nutzung ohne ChatGPT-Verbindung bleiben lokale Regeln, IMAP/SMTP, Suche und E-Mail-Verwaltung verfügbar. Die KI-Funktionen brauchen eine funktionierende ChatGPT-Verbindung und können Nutzungsbeschränkungen unterliegen.

## Datenschutz und Speicherort

- E-Mails, lokale Entwürfe und Einstellungen werden auf diesem Windows-Gerät gespeichert.
- ChatGPT-Tokens und E-Mail-Passwörter werden verschlüsselt im Windows-Benutzerprofil hinterlegt.
- Nachrichten werden als Text angezeigt. Externe Bilder werden nicht automatisch geladen.
- Anhänge werden erst dann in einen Zielordner geschrieben, wenn du sie speicherst.
- Du kannst die ChatGPT-Verbindung jederzeit unter **Einstellungen → ChatGPT → Trennen** entfernen.
- Das Entfernen eines E-Mail-Kontos löscht dessen lokale Kopien in LumenMail. Es löscht keine Nachrichten auf dem Server deines Anbieters.

## Projekt selbst starten oder Installer bauen

Falls du den Quellcode verändern möchtest, installiere Node.js LTS. Öffne danach PowerShell in diesem Projektordner:

```powershell
npm install
npm start
```

Um den Windows-Installer neu zu erzeugen:

```powershell
npm run dist
```

Der Installer erscheint anschließend in `release`. Das Programm nutzt Electron, sql.js, IMAPFlow, Nodemailer und Mailparser.

## Hinweis

LumenMail ist ein eigenständiges, lokal installiertes Programm. Es ist kein Outlook-Produkt und nicht mit dem Microsoft-Dienst verbunden. Server- und Anmeldeanforderungen können je nach Anbieter und Kontotyp abweichen.

