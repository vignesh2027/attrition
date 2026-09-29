import {Sentinel} from '@/components/Sentinel'
import {samples} from '@/lib/samples'

export default function Page() {
  return <Sentinel samples={samples()} />
}
