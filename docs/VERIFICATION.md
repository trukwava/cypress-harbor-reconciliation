# Verifiable reconciliation pack

The exported JSON preserves the exact UTF-8 text of each included source CSV, together with its recorded SHA-256 digest. On export the server recomputes each digest and refuses to export a mismatched source with HTTP 409.

To check a pack independently, save the following as a short Python script and point it at the downloaded JSON:

```python
import hashlib, json
from pathlib import Path
pack = json.loads(Path('reconciliation.json').read_text(encoding='utf-8'))
for report in pack['source_reports']:
    csv = report['raw_csv'].removeprefix('\ufeff')
    digest = hashlib.sha256(csv.encode('utf-8')).hexdigest()
    assert digest == report['raw_sha'], report['id']
print('Verified source reports:', len(pack['source_reports']))
```

This verifies the correspondence between the exported original source bytes and their stored hashes. **It is not a digital signature, third-party attestation, bank verification, or independent timestamp.** The application has no real financial-system integrations.

The export includes the complete contents of original CSV reports, plus normalized source rows, frozen obligations/payments/allocations, and the exception and reviewer context. In any future real-data deployment, treat these packs as sensitive and enforce strict download authorization, retention, and encryption. This application is synthetic and localhost-only.

The original source balance must not be conflated with an explanatory remainder; reconciliation and reviewer decisions do not establish collectible debt.
