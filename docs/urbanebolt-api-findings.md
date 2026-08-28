# UrbaneBolt UAT API — empirically verified (2026-08-27)

Base: `https://uat.urbanebolt.in`
Creds (public, from Postman docs): `info@urbanebolt.com` / `EKIcygsLVV5RCtPZ`
Account: `customerCode: UEBCUS0008`

## 1. Auth — POST /api/v1/auth/getToken/

Body: `{"username","password"}`
OK (200): `{"access_token","expires_in":86400,"token_type":"Bearer","expires":"ISO","status":"Success"}`
Bad creds (**HTTP 200**): `{"status":"Failed","message":"Incorrect username/password!"}`
Repeated getToken returns the **same** token until expiry → cacheable, TTL 24h.

## 2. Create shipment — POST /api/v1/services/manifest/

Body is an **ARRAY** — natively batch.
Header: `Authorization: Bearer <token>`
OK (200):

```json
{
  "status": "Success",
  "successResponse": [
    {
      "status": "Success",
      "orderNumber": "...",
      "awbNumber": 200000007430,
      "routeCode": "GGN/DLHH",
      "shippingLabel": "https://...",
      "customerCode": "UEBCUS0008"
    }
  ],
  "errorResponse": []
}
```

Per-item failures land in `errorResponse[]` — partial success is native:

- duplicate: `{"orderNumber","customerCode","status":"Failed","message":"orderNumber already shipped!"}`
- validation: `message: "'shprName' is a required property, 'shprAddress' is a required property, ..."`
- serviceability: `message: "Consignee Pincode 999999 is not serviceable"`

Required fields (from server-side validation error): shprName/Address/AddressType/City/State/Pincode/Mobile,
rtnName/Address/City/State/Country/Pincode/Mobile, consName/Address/AddressType/City/State/Pincode/Mobile,
payMode, collectableValue, declaredValue, invoiceValue, itemDescription, itemQuantity, pieces,
weight, length, breadth, height, serviceType. Plus customerCode, orderNumber.
Vocabularies: `serviceType`: SDD|NDD|ATA|PTP|2HR|IMP · `payMode`: COD|PPD

## 3. Track — GET /api/v1/services/tracking-pub/?awb=<awb>

OK (200): `{"status":"Success","message":"Tracking","data":{ awbNumber, orderNumber, pieces,
  currentStatusCode:"CAN", currentStatusCodeDescription:"Cancelled", currentStatusDateTime:"27 Aug 2026, 17:34",
  currentReasonCode, edd, origin, destination, currentLocation, isRto, weight, productType, remarks,
  scans:[{statusDateTime, statusCode, statusCodeDescription, reasonCode, reasonCodeDescription, currentLocation}] }}`
Unknown AWB (**HTTP 200**): `{"status":"Failed","message":"Data Not Found","data":[]}`
Bad/expired token (**HTTP 401**): `{"detail":"Authentication credentials were not provided."}` ← different shape
Observed status codes: `MAN` Shipment Manifested, `CAN` Cancelled. Date format: `"27 Aug 2026, 17:34"`.
`scans` is newest-first.

## 4. Cancel — POST /api/v1/services/cancel/

Body: `{"awbs":"200000007430"}` — comma-separated string, also batch.
OK (200): `{"status":"Success","message":"Cancellation Proccess",
  "successResponse":[{"orderNumber","awb","message":"Cancelled"}],"failureResponse":[]}`
Already cancelled: `failureResponse:[{"orderNumber","awb","message":"Shipment already cancelled!"}]`
Unknown AWB: `failureResponse:[{"orderNumber":"","awb","message":"Requested AWB not found or may be not belong to your account"}]`
Note key is `failureResponse` here vs `errorResponse` on manifest — inconsistent.

## 5. Serviceability — GET /api/v1/location/pincodes/?pincodes=122001,122017

`{"status":"Success","message":"Pincodes","data":[{pincode,inbound,outbound,rtn,isActive,serviceCenter,
  city,state,region,zone,routeCode,serviceType:"SDD,NDD,ATA,PTP,2HR"}],"errorPincodes":[]}`

## 6. Label — GET /api/v1/services/label/?awbs=<awb>

`{"status":"Success","message":"Shipments","data":[{awb,order_number,consignee{...},returnDetail{...},...}],"errData":[]}`

## 7. Other endpoints (out of assignment's minimum scope)

NDR RTO: `POST /api/v1/services/ndr/?type=rtoLock` body `{"awbs":"..."}`
NDR re-attempt: `POST /api/v1/services/ndr/?type=reAttempt` body `[{awb,name,address,city,state,pincode,mobile,email}]`
PayMode change: `POST /api/v1/services/update-paymode/` body `{"awbs":"a,b"}`
ePOD: `GET /api/v1/services/epod/?awbs=<awb>`
Global manifest: `POST /api/v1/services/global-manifest/` (international, extra fields: isDG, GST, lat/lng, volWeight)

## DESIGN IMPLICATIONS

1. **HTTP 200 ≠ success.** Every business error comes back 200 with `status:"Failed"` or a populated
   `errorResponse`/`failureResponse` array. Only token auth failure gives a real 401 (with a _different_ body shape).
   → success/failure classification MUST live in the adapter, not in a shared HTTP client.
2. **Manifest is natively batch.** A naive design fires 100 single-item calls. A capability-aware design
   (`supportsBatchCreate`) chunks and issues ~N/chunk calls. Big differentiator for the bulk requirement.
3. **Courier-side idempotency exists** ("orderNumber already shipped!") but is not a substitute for
   our own idempotency — it can't be relied on across couriers.
4. **Token is stable + 24h TTL** → cache it; refresh only on 401, then retry once (matches assignment 3.5).
5. **customerCode is account config**, never part of the unified DTO.
6. **serviceType / payMode are courier vocabularies** → unified DTO needs its own enum + per-adapter mapping.
7. **Three addresses** (shipper / return / consignee) are all mandatory → unified DTO shape must cover them.
