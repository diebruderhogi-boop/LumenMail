# LumenMail

LumenMail ist ein Windows-E-Mail-Client mit IMAP/SMTP, lokalem Postfach, Entwürfen, Kategorien und einem integrierten ChatGPT-Assistenten.

## Installieren

Für die normale Nutzung brauchst du nur die aktuelle Windows-Setup-Datei aus dem [GitHub-Release-Bereich](https://github.com/diebruderhogi-boop/LumenMail/releases):

1. Lade die neueste Datei `LumenMail-Setup-<Version>.exe` herunter und doppelklicke darauf.
2. Wähle bei Bedarf den Installationsordner.
3. Lass die Verknüpfung im Startmenü oder auf dem Desktop erstellen.
4. Starte LumenMail und füge dein E-Mail-Konto hinzu.

Der Installer ist ein Windows-Programm-Setup. Node.js brauchst du zum Installieren und Verwenden nicht.

## E-Mail-Konto einrichten

LumenMail verbindet sich mit IMAP zum Empfangen und SMTP zum Versenden. Der Einrichtungsdialog bietet Voreinstellungen für Gmail, T‑Online, iCloud und Outlook sowie eigene Serverdaten.

- **Gmail:** IMAP im Google-Konto aktivieren und ein Google-App-Passwort verwenden. Das normale Kontopasswort wird meist nicht angenommen. Leerzeichen im App-Passwort entfernt LumenMail automatisch.
- **T‑Online:** LumenMail trägt `secureimap.t-online.de:993` und `securesmtp.t-online.de:465` ein. Verwende das Telekom-„Passwort für E‑Mail‑Programme“.
- **iCloud Mail (`@icloud.com`):** LumenMail trägt `imap.mail.me.com:993` und `smtp.mail.me.com:587` ein. Apple verlangt für die Anmeldung in einer Drittanbieter-App ein App-spezifisches Passwort. Erstelle es in deinem Apple Account unter „Anmelden und Sicherheit → App-spezifische Passwörter“.
- **Outlook / Microsoft 365:** Für persönliche Adressen wie `@outlook.com`, `@hotmail.com`, `@live.com` und `@msn.com` trägt LumenMail `outlook.office365.com:993` und `smtp-mail.outlook.com:587` ein. Geschäftskonten verwenden standardmäßig `smtp.office365.com:587`. Für die direkte Microsoft-Anmeldung zeigt LumenMail einen QR-Code und einen Bestätigungscode; IMAP muss im Outlook.com-Konto eingeschaltet sein.
- **Andere Anbieter:** IMAP-/SMTP-Adressen, Ports und Anmeldeart beim E-Mail-Anbieter nachsehen.

**Direktanmeldung für Gmail und Outlook:** LumenMail kann Google im Browser und Microsoft mit QR-Code und Bestätigungscode anbinden. Für einen Installer müssen die öffentlichen App-IDs von Google und Microsoft in den Konstanten `publicClientIds` in `src/main/mail-oauth-config.js` eingetragen sein. Ohne eine App-ID bleibt der jeweilige Anmeldeknopf deaktiviert. Bei Gmail öffnet sich die Google-Anmeldung im Browser; eine Sicherheitsabfrage kann am Handy bestätigt werden. Google bietet für den Gmail-Mailzugriff keinen normalen QR-Gerätecode. Microsoft stellt für Outlook einen Gerätecode bereit, den du nach dem Scannen auf der Microsoft-Seite eingibst. Gmail verlangt für die öffentliche Verteilung mit dem vollen Mailzugriff eine OAuth-Prüfung; im Testmodus laufen Google-Refresh-Tokens nach sieben Tagen ab. T‑Online und iCloud verwenden weiterhin App-Passwörter.

Die Zugangsdaten und OAuth-Tokens werden mit dem Windows-Schlüsselspeicher verschlüsselt. Verbindungsfehler zeigen Hinweise für Server, Port, TLS und Anmeldung. Beim Speichern prüft LumenMail sowohl den IMAP-Empfang als auch den SMTP-Versand, bevor das Konto übernommen wird.

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

