import { KAKAO_MAP_APP_KEY } from './config.js';

let sdkReady = false;

export function isKakaoMapConfigured() {
  return Boolean(KAKAO_MAP_APP_KEY) && !KAKAO_MAP_APP_KEY.includes('YOUR_KAKAO');
}

export async function loadKakaoMapSDK() {
  if (!isKakaoMapConfigured()) {
    throw new Error('js/config.js에 카카오 JavaScript 키를 입력하세요.');
  }

  if (sdkReady && window.kakao?.maps) {
    return window.kakao.maps;
  }

  await new Promise((resolve, reject) => {
    if (window.kakao?.maps) {
      window.kakao.maps.load(resolve);
      return;
    }

    const script = document.createElement('script');
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_MAP_APP_KEY}&autoload=false&libraries=services`;
    script.onload = () => window.kakao.maps.load(resolve);
    script.onerror = () => reject(new Error('카카오맵 SDK를 불러오지 못했습니다.'));
    document.head.appendChild(script);
  });

  sdkReady = true;
  return window.kakao.maps;
}

export function createScheduleMapPicker(container, { onSelect, initial = null } = {}) {
  let map;
  let marker;
  let selected = initial;

  const places = new window.kakao.maps.services.Places();
  const geocoder = new window.kakao.maps.services.Geocoder();

  const center = initial?.lat && initial?.lng
    ? new window.kakao.maps.LatLng(initial.lat, initial.lng)
    : new window.kakao.maps.LatLng(37.5665, 126.9780);

  map = new window.kakao.maps.Map(container, {
    center,
    level: 3,
  });

  if (initial?.lat && initial?.lng) {
    marker = new window.kakao.maps.Marker({ map, position: center });
  }

  function setLocation(lat, lng, name) {
    selected = { lat, lng, name: name || '' };
    const position = new window.kakao.maps.LatLng(lat, lng);
    if (!marker) {
      marker = new window.kakao.maps.Marker({ map, position });
    } else {
      marker.setPosition(position);
    }
    map.setCenter(position);
    onSelect?.(selected);
  }

  window.kakao.maps.event.addListener(map, 'click', (mouseEvent) => {
    const lat = mouseEvent.latLng.getLat();
    const lng = mouseEvent.latLng.getLng();

    geocoder.coord2Address(lng, lat, (result, status) => {
      const name = status === window.kakao.maps.services.Status.OK
        ? result[0]?.road_address?.address_name || result[0]?.address?.address_name || '선택한 위치'
        : '선택한 위치';
      setLocation(lat, lng, name);
    });
  });

  function search(keyword) {
    if (!keyword.trim()) return Promise.resolve([]);

    return new Promise((resolve) => {
      places.keywordSearch(keyword, (data, status) => {
        if (status !== window.kakao.maps.services.Status.OK) {
          resolve([]);
          return;
        }
        resolve(data);
      });
    });
  }

  function selectSearchResult(place) {
    const lat = Number(place.y);
    const lng = Number(place.x);
    setLocation(lat, lng, place.place_name);
    map.setLevel(3);
  }

  function getSelected() {
    return selected;
  }

  function reset() {
    selected = null;
    if (marker) {
      marker.setMap(null);
      marker = null;
    }
    map.setCenter(new window.kakao.maps.LatLng(37.5665, 126.9780));
    map.setLevel(3);
  }

  return { search, selectSearchResult, getSelected, reset };
}

export function renderMiniMap(container, { lat, lng, title }) {
  const center = new window.kakao.maps.LatLng(lat, lng);
  const map = new window.kakao.maps.Map(container, {
    center,
    level: 3,
    draggable: false,
    scrollwheel: false,
    disableDoubleClick: true,
  });

  new window.kakao.maps.Marker({
    map,
    position: center,
    title: title || '모임 장소',
  });

  return map;
}

export function getDirectionsUrl(name, lat, lng) {
  const label = encodeURIComponent(name || '모임장소');
  return `https://map.kakao.com/link/map/${label},${lat},${lng}`;
}
