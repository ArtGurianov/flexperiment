import { storefrontMyOrigin } from "../../../lib/my-storefront";
import LabV2Client from "../components/LabV2Client";

export default function Page() {
  return <LabV2Client myOrigin={storefrontMyOrigin(process.env)} />;
}
