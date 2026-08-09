/**
 * Frozen test fixtures. FIXTURE_PDF_B64 is a real two-page PDF built once
 * with reportlab (see tools/shelf.py _make_fixture_pdf) and frozen here so
 * its bytes - and therefore its content HASH - never change between runs:
 * the shelf's idempotency tests depend on re-uploading the exact same book.
 * Two headed sections of setting-flavoured prose; parses under pypdf (the
 * detector's sniff) and pdfplumber (the splitter), classifies as settings.
 */

export const FIXTURE_NAME = 'Gym-Fixture-Gazetteer.pdf';

export const FIXTURE_PDF_B64 = 'JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwK'
  + 'L0YxIDIgMCBSIC9GMiAzIDAgUgo+PgplbmRvYmoKMiAwIG9iago8PAovQmFzZUZvbnQgL0hlbHZldGljYSAvRW5jb2Rpbmcg'
  + 'L1dpbkFuc2lFbmNvZGluZyAvTmFtZSAvRjEgL1N1YnR5cGUgL1R5cGUxIC9UeXBlIC9Gb250Cj4+CmVuZG9iagozIDAgb2Jq'
  + 'Cjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhLUJvbGQgL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcgL05hbWUgL0YyIC9TdWJ0'
  + 'eXBlIC9UeXBlMSAvVHlwZSAvRm9udAo+PgplbmRvYmoKNCAwIG9iago8PAovQ29udGVudHMgOSAwIFIgL01lZGlhQm94IFsg'
  + 'MCAwIDYxMiA3OTIgXSAvUGFyZW50IDggMCBSIC9SZXNvdXJjZXMgPDwKL0ZvbnQgMSAwIFIgL1Byb2NTZXQgWyAvUERGIC9U'
  + 'ZXh0IC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJIF0KPj4gL1JvdGF0ZSAwIC9UcmFucyA8PAoKPj4gCiAgL1R5cGUgL1BhZ2UK'
  + 'Pj4KZW5kb2JqCjUgMCBvYmoKPDwKL0NvbnRlbnRzIDEwIDAgUiAvTWVkaWFCb3ggWyAwIDAgNjEyIDc5MiBdIC9QYXJlbnQg'
  + 'OCAwIFIgL1Jlc291cmNlcyA8PAovRm9udCAxIDAgUiAvUHJvY1NldCBbIC9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9J'
  + 'bWFnZUkgXQo+PiAvUm90YXRlIDAgL1RyYW5zIDw8Cgo+PiAKICAvVHlwZSAvUGFnZQo+PgplbmRvYmoKNiAwIG9iago8PAov'
  + 'UGFnZU1vZGUgL1VzZU5vbmUgL1BhZ2VzIDggMCBSIC9UeXBlIC9DYXRhbG9nCj4+CmVuZG9iago3IDAgb2JqCjw8Ci9BdXRo'
  + 'b3IgKGFub255bW91cykgL0NyZWF0aW9uRGF0ZSAoRDoyMDI2MDgwOTA3MDkyMi0wNScwMCcpIC9DcmVhdG9yIChhbm9ueW1v'
  + 'dXMpIC9LZXl3b3JkcyAoKSAvTW9kRGF0ZSAoRDoyMDI2MDgwOTA3MDkyMi0wNScwMCcpIC9Qcm9kdWNlciAoUmVwb3J0TGFi'
  + 'IFBERiBMaWJyYXJ5IC0gXChvcGVuc291cmNlXCkpIAogIC9TdWJqZWN0ICh1bnNwZWNpZmllZCkgL1RpdGxlICh1bnRpdGxl'
  + 'ZCkgL1RyYXBwZWQgL0ZhbHNlCj4+CmVuZG9iago4IDAgb2JqCjw8Ci9Db3VudCAyIC9LaWRzIFsgNCAwIFIgNSAwIFIgXSAv'
  + 'VHlwZSAvUGFnZXMKPj4KZW5kb2JqCjkgMCBvYmoKPDwKL0ZpbHRlciBbIC9BU0NJSTg1RGVjb2RlIC9GbGF0ZURlY29kZSBd'
  + 'IC9MZW5ndGggMjcyCj4+CnN0cmVhbQpHYXNLNTV1LDxPJi1eRi86W3NkJTpsKG1ISkwqayYjLWpVKTlbY1JMRTl0WjtXJStd'
  + 'OEZbW1xrSnJNKVYpKmBWJylEdDJLXStLOTFnY1FJQSMxVVBsWCM5KUVPMGdCXm80cmYkQ3NZKFJSaTQtQ0p1akstMzhnMmg2'
  + 'cmJMPEsmL2FvJFlCPTZsOm11PzBtampwNGsnaTQxJjlZcTZCXW1oMjRTOFAmZ28/allYOj9yU1dpLiJrR010ZmsscWo1Oilx'
  + 'YlUlLFcxNDdOVTdbJEhJaWRpZkpEakxGJjtaI01uNVBxTl1VTU9IRWQzW0hjRmxDZG4oQiFTXG10aEsuNydub08kXTNKbDk2'
  + 'bm5gOXN+PmVuZHN0cmVhbQplbmRvYmoKMTAgMCBvYmoKPDwKL0ZpbHRlciBbIC9BU0NJSTg1RGVjb2RlIC9GbGF0ZURlY29k'
  + 'ZSBdIC9MZW5ndGggMjI1Cj4+CnN0cmVhbQpHYXJXcVltUz8lKF4vZFFWbW9TbUMoY0VgLl08Vyk5NW1dIlwjRDJVOGNDMmZI'
  + 'YS0sSGksWl5VSG1eJ1srVCZmNEAmcFFmOTFUNTdMV20oRXFMa0Uyb1koK1ViOmcsJD09WEY+MFwpSi4wZkBwO2EuW1FnIzVz'
  + 'KEQmKCg/Lz9WJTcma2tUZEdXLEUhWScwKldlTjUqMU9FRWEsI0hHJT4nVjIzLEY7dFNjPG4mSl5OPDo6a2dUcVRpXyJAamZI'
  + 'T1spXiIqU1xgJyRhOnBBJGwtW0VWQWNHJF1FLiNgO28vfj5lbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCAxMQowMDAwMDAwMDAw'
  + 'IDY1NTM1IGYgCjAwMDAwMDAwNjEgMDAwMDAgbiAKMDAwMDAwMDEwMiAwMDAwMCBuIAowMDAwMDAwMjA5IDAwMDAwIG4gCjAw'
  + 'MDAwMDAzMjEgMDAwMDAgbiAKMDAwMDAwMDUxNCAwMDAwMCBuIAowMDAwMDAwNzA4IDAwMDAwIG4gCjAwMDAwMDA3NzYgMDAw'
  + 'MDAgbiAKMDAwMDAwMTAzNyAwMDAwMCBuIAowMDAwMDAxMTAyIDAwMDAwIG4gCjAwMDAwMDE0NjQgMDAwMDAgbiAKdHJhaWxl'
  + 'cgo8PAovSUQgCls8OTRhMTQ5NDUzZTkzNWE0NGM1N2E4OWNjMTc5YjExZDA+PDk0YTE0OTQ1M2U5MzVhNDRjNTdhODljYzE3'
  + 'OWIxMWQwPl0KJSBSZXBvcnRMYWIgZ2VuZXJhdGVkIFBERiBkb2N1bWVudCAtLSBkaWdlc3QgKG9wZW5zb3VyY2UpCgovSW5m'
  + 'byA3IDAgUgovUm9vdCA2IDAgUgovU2l6ZSAxMQo+PgpzdGFydHhyZWYKMTc4MAolJUVPRgo=';

/** The fixture as a Uint8Array, ready for fetch(..., { body }). */
export function fixturePdfBytes() {
  const bin = atob(FIXTURE_PDF_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
