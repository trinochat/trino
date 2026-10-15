/**
 * The bridge search of this network (bridge-search.ts) and its state, for
 * a screen: the same search wherever it was started.
 */
import { useEffect, useState } from 'react';
import { bridgeSearchOf, type BridgeSearch, type SearchApi, type SearchState } from './bridge-search';

export function useBridgeSearch(api: SearchApi): [SearchState, BridgeSearch] {
  const search = bridgeSearchOf(api);
  const [state, setState] = useState<SearchState>(search.get);
  useEffect(() => {
    setState(search.get());
    return search.subscribe(setState);
  }, [search]);
  return [state, search];
}
