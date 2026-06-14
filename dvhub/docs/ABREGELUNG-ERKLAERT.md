# Abgeregelte Energie – einfach erklärt

Diese Seite erklärt in einfacher Sprache, wie DVhub die Karte **„Abgeregelte
Energie"** in der Historie berechnet. Sie ist für alle gedacht – man braucht kein
Technik- oder Solar-Wissen.

---

## Worum geht es?

Manchmal darf eine Solaranlage nicht so viel Strom ins Netz geben, wie sie
könnte. Sie wird **gedrosselt** (Fachwort: „abgeregelt"). Das passiert zum
Beispiel:

- wenn der Strompreis an der Börse **negativ** ist (es gibt zu viel Strom),
- durch die Regel **§51 EEG** (das „Solarspitzengesetz"),
- oder weil der **Direktvermarkter** die Anlage herunterregelt, um Verluste zu
  vermeiden.

In diesen Zeiten erzeugt die Anlage **weniger Strom als möglich**. Diese
Differenz nennen wir die **abgeregelte Energie**: der Strom, der **hätte**
erzeugt werden können, aber nicht durfte.

---

## Das Problem

Wir können den gedrosselten Strom **nicht direkt messen**. Ein Stromzähler zeigt
nur, was **wirklich** erzeugt wurde – nicht, was **möglich gewesen wäre**.

Wir müssen also **schätzen**, wie viel die Anlage ohne die Drosselung produziert
hätte. Dafür brauchen wir einen guten Maßstab.

---

## Die Idee: Sonne messen, daraus die Leistung lernen

Der beste Maßstab ist die **Sonneneinstrahlung** (Fachwort: *Globalstrahlung*
oder *GHI*). Sie sagt, wie viel Sonne gerade auf einen Quadratmeter fällt –
gemessen in Watt pro Quadratmeter (W/m²).

Der Gedanke ist einfach:

> **Wenn wir wissen, wie viel Strom die Anlage bei einer bestimmten Menge Sonne
> normalerweise macht, können wir für jeden gedrosselten Moment ausrechnen, wie
> viel sie ohne Drosselung gemacht hätte.**

Dafür sucht DVhub sich **normale Tage ohne Drosselung** (Tage ganz ohne negative
Viertelstunden) und schaut: *Wie viel Strom kam bei wie viel Sonne heraus?*
Daraus entsteht eine Art **Umrechnungsfaktor** zwischen Sonne und Leistung.

---

## Warum die *besten* Slots zählen, nicht der Durchschnitt

Hier steckt der wichtige Trick. Auch an Tagen **ohne** negative Preise ist die
Anlage manchmal **trotzdem** ein bisschen gedrosselt (z. B. weil der Akku voll
ist oder der Direktvermarkter regelt). Würden wir einfach den **Durchschnitt**
aller Tage nehmen, wäre der Maßstab zu niedrig – wir würden die Drosselung
**unterschätzen**.

Deshalb nimmt DVhub nicht den Durchschnitt, sondern die **obere Hüllkurve**:
es schaut sich an, was die Anlage an den **besten, ungedrosselten** Slots bei
viel Sonne **wirklich geschafft** hat. Genau das ist das „Soll" – das, was die
Anlage **kann**, wenn sie frei produzieren darf.

> Bild dazu: Wir fragen nicht „Wie viel macht die Anlage *im Schnitt*?",
> sondern „Wie viel macht sie *an ihren guten Tagen*?". Das ist ihr echtes
> Können.

Technisch nimmt DVhub dafür den **85. Prozentwert** der gemessenen
Sonne-zu-Strom-Verhältnisse pro Gruppe (siehe unten) – also einen der oberen
Werte, aber nicht den allerhöchsten Ausreißer.

---

## Warum nur die letzten Monate zählen

Eine Anlage **verändert sich** über die Zeit – sie wird zum Beispiel **erweitert**
(mehr Module). Alte Messwerte von einer kleineren Anlage würden den Maßstab
verfälschen.

Deshalb lernt DVhub nur aus den **letzten ~9 Monaten** (270 Tage). So passt der
Maßstab immer zur **heutigen** Anlage. Dieser Zeitraum lässt sich in den
Einstellungen anpassen.

---

## In Gruppen sortiert: Monat und Sonnenstand

Die Anlage liefert nicht bei jeder Sonne gleich viel:

- Im **Sommer** steht die Sonne hoch, im **Winter** tief.
- **Mittags** kommt mehr an als am **Morgen** oder **Abend**.

Damit der Maßstab stimmt, sortiert DVhub die Messwerte in **Gruppen** nach
**Monat** und **Sonnenhöhe** (wie hoch die Sonne am Himmel steht). Jede Gruppe
bekommt ihren eigenen Umrechnungsfaktor.

Hat eine Gruppe **zu wenige** Messwerte, gilt sie als „unsicher" und DVhub nimmt
stattdessen einen **allgemeinen Mittelwert** aus den sicheren Gruppen.

---

## So wird gerechnet – Schritt für Schritt

Für **jede gedrosselte Viertelstunde** (also jede mit negativem Preis):

1. **Sonne nachschlagen:** Wie viel Sonne (GHI) gab es in dieser Viertelstunde?
2. **Soll ausrechnen:** Mit dem gelernten Umrechnungsfaktor wird daraus die
   Leistung berechnet, die die Anlage **gehabt hätte**. (Begrenzt durch die
   maximale Wechselrichter-Leistung – mehr geht technisch nicht.)
3. **Ist abziehen:** Was hat die Anlage in dieser Viertelstunde **wirklich**
   produziert?
4. **Differenz = abgeregelt:** *Soll minus Ist* ist die abgeregelte Energie
   dieser Viertelstunde. (Nie negativ – wenn „Ist" mal höher ist, zählt 0.)

Am Ende werden alle Viertelstunden eines Tages, Monats oder Jahres
**zusammengezählt**.

### Ein Rechenbeispiel

> In einer Mittags-Viertelstunde scheint die Sonne mit **800 W/m²**.
> Der gelernte Faktor sagt: Bei so viel Sonne macht die Anlage normalerweise
> **18 kW**. In 15 Minuten wären das **4,5 kWh** (das „Soll").
> Tatsächlich hat die gedrosselte Anlage nur **1,0 kWh** produziert (das „Ist").
> → **Abgeregelt: 4,5 − 1,0 = 3,5 kWh** in dieser Viertelstunde.

---

## Woher die Sonnendaten kommen

DVhub nutzt mehrere Quellen für die Globalstrahlung, in dieser Reihenfolge:

1. **Lokale Wetterstation** (falls eingebunden, z. B. über Loxberry/MQTT) –
   echte Messung vor Ort, viertelstundengenau. **Am besten.**
2. **Wetter-Archiv (Open-Meteo / ERA5)** – berechnete Rückschau für deinen Ort,
   stündlich. Wird automatisch bis zur Inbetriebnahme rückwirkend befüllt.
3. **Wettervorhersage** – nur als Lückenfüller für die letzten Tage, die das
   Archiv noch nicht abgedeckt hat.

In den Einstellungen (Forecast → Globalstrahlung) kann man wählen, welche Quelle
**Vorrang** hat – die lokale Messung oder das Archiv.

Wichtig: Die Berechnung ist **idempotent**. Das heißt: Sie verwendet nur
**gespeicherte Messwerte** (keine sich ändernden Vorhersagen für die
Kalibrierung). Dieselbe Eingabe ergibt also immer dasselbe Ergebnis – auch wenn
man neu rechnet.

---

## §51 EEG: Volllastviertelstunden und Förderverlängerung

Die negativen Viertelstunden haben noch eine zweite Bedeutung. Nach **§51 EEG**
(Solarspitzengesetz) bekommt man für die in Negativzeiten **verlorene** Förderung
am Ende eine **Verlängerung des Förderzeitraums**.

Dafür werden die negativen Viertelstunden in **Volllastviertelstunden**
umgerechnet (vereinfacht: Anzahl negativer Viertelstunden geteilt durch zwei).
Aus diesen ergibt sich, um wie viele **Monate** sich die Förderung verlängert.

Diese **Förderverlängerung** wird nur in der **Jahresansicht** angezeigt, weil
sie sich über längere Zeiträume sammelt.

---

## Der Erlös (Börsen-Durchschnitt)

Auf der Karte steht auch ein **potenzieller Erlös**: Was hätte der abgeregelte
Strom ungefähr **eingebracht**, wenn er hätte verkauft werden können?

Dafür wird die abgeregelte Energie mit dem **Monatsdurchschnitt des Börsenpreises**
multipliziert. Das ist ein grober Richtwert, kein exakter Geldbetrag.

---

## Ehrliche Grenzen

Diese Berechnung ist eine **gute Schätzung**, kein perfekter Messwert. Sie ist
so genau wie:

- die **Sonnendaten** (eine lokale Messstation ist besser als das Archiv),
- die Zahl der **sauberen Tage**, aus denen gelernt werden konnte,
- und wie gut die Anlage zur gelernten Gruppe passt.

Eine ganz frische Anlage braucht erst ein paar sonnige, ungedrosselte Tage,
bevor die Schätzung verlässlich wird. Danach verbessert sie sich automatisch von
selbst.

---

*Für Technik-Interessierte: Die genaue Methode (Hüllkurven-Fit, Sonnenstands-Bänder,
Temperatur-Korrektur, Wechselrichter-Begrenzung) steht in
`services/curtailment/` und in `.planning/T-CURTAIL-IRRADIANCE-DESIGN.md`.*
