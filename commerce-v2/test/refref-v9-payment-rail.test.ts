import {describe,expect,it,vi} from "vitest";
import {RefrefV9PaymentRail} from "../src/refref-v9-payment-rail";

describe("v9 explicit local transport admission",()=>{
 it.each(["production","staging"])("refuses %s before an HTTP operation",environment=>{
  const request=vi.fn<typeof fetch>();
  expect(()=>new RefrefV9PaymentRail({apiBaseUrl:"https://api.refref.test/v1-v9",apiKey:"synthetic",businessId:"business",
   environment:environment as "test",fetch:request})).toThrow("V9_LOCAL_QUALIFICATION_ONLY");
  expect(request).not.toHaveBeenCalled();
 });
 it.each(["https://api.refref.test/v1-rc","https://user:secret@api.refref.test/v1-v9","https://api.refref.test/v1-v9?mode=live"])("refuses an unqualified base %s",apiBaseUrl=>{
  expect(()=>new RefrefV9PaymentRail({apiBaseUrl,apiKey:"synthetic",businessId:"business",environment:"test"})).toThrow("V9_API_BASE_INVALID");
 });
 it("cannot silently route a v9 refund through the RC.2 rail",async()=>{
  const request=vi.fn<typeof fetch>();const rail=new RefrefV9PaymentRail({apiBaseUrl:"http://127.0.0.1:1/v1-v9",apiKey:"synthetic",businessId:"business",environment:"test",fetch:request});
  await expect(rail.readRefund("unknown")).rejects.toThrow("V9_REFUND_TRANSPORT_NOT_QUALIFIED");
  await expect(rail.readRefundExecution("unknown")).rejects.toThrow("V9_REFUND_TRANSPORT_NOT_QUALIFIED");
  expect(request).not.toHaveBeenCalled();
 });
});
