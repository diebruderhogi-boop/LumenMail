# Änderungen

## 1.0.5

- Zeigt beim Prüfen neuer Mailkonten verständliche IMAP- und SMTP-Fehler samt Serverhinweis statt nur „Command failed“.
- Erkennt typische Ablehnungen von Anmeldedaten und Verbindungen über IMAP- und SMTP-Serverantworten.

## 1.0.4

- Sichert die dynamische ChatGPT-Client-ID vor dem Tokenaustausch und verwendet sie nach `invalid_grant` bei einer neuen Anmeldung erneut.
- Zeigt verständliche deutsche Hinweise bei Fehlern der ChatGPT-Verbindung.

## 1.0.3

- Startet auch dann, wenn der verschlüsselte Zugangsdaten-Speicher beschädigt ist.
- Sichert unlesbare Zugangsdaten-Dateien und führt durch die erneute Eingabe der Mail-Passwörter.

## 1.0.2

- Prüft beim Speichern sowohl IMAP-Empfang als auch SMTP-Versand.
- Verwendet beim Bearbeiten eines Kontos gespeicherte Zugangsdaten weiter, wenn das Passwortfeld leer bleibt.
- Korrigiert den Gmail-Hinweis zum App-Passwort.
- Verhindert, dass eine ChatGPT-Neuanmeldung versehentlich ein anderes gespeichertes Konto ersetzt.
- Prüft bei der ChatGPT-Anmeldung die vom Token-Dienst bestätigten Berechtigungen.
- Entfernt versehentliche Leerzeichen aus Gmail-App-Passwörtern.
- Dokumentiert ausdrücklich, dass die Desktop-Version keine QR-Kopplung für E-Mail-Konten enthält.

