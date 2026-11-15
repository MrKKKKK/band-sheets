#!/bin/bash
# Fetch the held-out piano timbre of spike 7's synthetic chords (docs/audio-spike7-plan.md section 3.1, T5).
# VSCO 2: Community Edition "Upright Piano" (Upright No. 1, sampled by Simon Dalzell / Ivy Audio, Versilian Studios),
# repo license CC0 1.0 Universal (LICENSE at the repo root; Readme.txt asks for credit, see ts/THIRD_PARTY.md).
# 69 WAV files (24 bit stereo 44.1 kHz; 3 dynamics x 23 keys, every 4 semitones; key per file in MappingChart.txt) +
# the license / readme / info files, from the pinned commit below; every file SHA-256 pinned 2026-11-15 (the downloads
# were also checked against the commit's git blob hashes). The repo has no sfz for this piano: render/chords2/pianos.ts
# maps the files with MappingChart.txt. HELD-OUT ONLY (render/chords2/variants.ts refuses it elsewhere).
# Samples go to spikes/analysis/pianokits/ (gitignored) and never into git or the app. 0.25 GB.
#
# Usage: bash spikes/analysis/fetch-piano-samples.sh
# Idempotent: files whose SHA-256 matches the pin are skipped; a mismatch aborts. Needs curl, sha256sum.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HERE/pianokits/vsco_upright"
COMMIT=440300901dfe9275fd84e0b7763af1f8443ae62e
BASE="https://raw.githubusercontent.com/sgossner/VSCO-2-CE/$COMMIT"
mkdir -p "$DEST"

# sha256 | local name | path in the repo
PINS=(
  "36ffd9dc085d529a7e60e1276d73ae5a030b020313e6c5408593a6ae2af39673|LICENSE|LICENSE"
  "101ddb88eb013900cc911834ecbdfbd49497bcd913bf09417160b9677952bb38|Readme.txt|Readme.txt"
  "a3bd9d49720187b10269e78b091316d043dcd7b059ec77edb582195152aaf1ce|Info.txt|Keys/Upright Piano/Info.txt"
  "9ccfbdee3d58873e9632ba188ed5837979948eb7868e824ec24e0d3eb4e3fda8|MappingChart.txt|Keys/Upright Piano/MappingChart.txt"
  "e61aeb988bf05181b5666ec1ff24b3f4ca375517c7ea47b87a009bc116fca56d|Player_dyn1_rr1_000.wav|Keys/Upright Piano/Player_dyn1_rr1_000.wav"
  "a09c3877aa0c5c33259a4122d732000975915ff64d7862cf37586c7404248424|Player_dyn1_rr1_002.wav|Keys/Upright Piano/Player_dyn1_rr1_002.wav"
  "511af05989eb9636cb79d2c10caf58fe6d3c07f907f4380951b5640c5f11e06d|Player_dyn1_rr1_004.wav|Keys/Upright Piano/Player_dyn1_rr1_004.wav"
  "485d6822e74b73f6bb38ff221fd7c4b55316c5653cf10d1edfcf471a32adf3dd|Player_dyn1_rr1_006.wav|Keys/Upright Piano/Player_dyn1_rr1_006.wav"
  "3b4cdd096b01b23a81b2ad8ad880c409c8a78d69cd0306fe9bf66795cd62acca|Player_dyn1_rr1_008.wav|Keys/Upright Piano/Player_dyn1_rr1_008.wav"
  "6bdbe8457f7b921ddfd2456aa5dd5932e60a687ca6fb255b3b80ffc6eecbd199|Player_dyn1_rr1_010.wav|Keys/Upright Piano/Player_dyn1_rr1_010.wav"
  "16be23a8378185f1b392600d3fa800a206945543866548640f7573534f76faf2|Player_dyn1_rr1_012.wav|Keys/Upright Piano/Player_dyn1_rr1_012.wav"
  "f3d00b63bb178680fdd4d9ed7ea43d1df1cf29e00b567ccb022c2bd411a20607|Player_dyn1_rr1_014.wav|Keys/Upright Piano/Player_dyn1_rr1_014.wav"
  "f1a3a542cf70a13aa865ce130d50d72cd735449e605d1c5a45dc06b5a60b27fd|Player_dyn1_rr1_016.wav|Keys/Upright Piano/Player_dyn1_rr1_016.wav"
  "01387cb5318c5abf11410ae8e2f4ef6aa83ec03254b4bccfe865aba262a2e412|Player_dyn1_rr1_018.wav|Keys/Upright Piano/Player_dyn1_rr1_018.wav"
  "08242e8d1c865c8cdc794cc7921d3d9663bedb5a12bfefe0de13aaa86fd23133|Player_dyn1_rr1_020.wav|Keys/Upright Piano/Player_dyn1_rr1_020.wav"
  "660e57ad8fd868ed9c56fe36e4862a6aff1cb65b7838a568d4c4f2f0865ad1ab|Player_dyn1_rr1_022.wav|Keys/Upright Piano/Player_dyn1_rr1_022.wav"
  "916c3ec2d61fb421e74fb4866ef75d3ef17e9d88e9dc858da24159846489d33f|Player_dyn1_rr1_024.wav|Keys/Upright Piano/Player_dyn1_rr1_024.wav"
  "254be5d34270e5eb78bbda3f7425c3e82b9596845db2c065b13179f23c23196b|Player_dyn1_rr1_026.wav|Keys/Upright Piano/Player_dyn1_rr1_026.wav"
  "a9fbd1af0703b294d3267f8f88fca4b4366e3b772f7d780acf2de1cbf2056355|Player_dyn1_rr1_028.wav|Keys/Upright Piano/Player_dyn1_rr1_028.wav"
  "d3d47e12108098d25a490fbac30cbbf29dfac801bbebd62b969cc1fe7a8342e5|Player_dyn1_rr1_030.wav|Keys/Upright Piano/Player_dyn1_rr1_030.wav"
  "2a903396ee7130c42a75aa10497c6ee018445e0934dde135e7f168f07d3b8a07|Player_dyn1_rr1_032.wav|Keys/Upright Piano/Player_dyn1_rr1_032.wav"
  "c9bdc616f2f289c16ebf40a33dd26c8cd55db92d6cfa6cda0792805ebfbf25dc|Player_dyn1_rr1_034.wav|Keys/Upright Piano/Player_dyn1_rr1_034.wav"
  "6dfbe8f959d75a52eadfa5802ac05e52684e8acacb5cb4ed39e858f7359e0385|Player_dyn1_rr1_036.wav|Keys/Upright Piano/Player_dyn1_rr1_036.wav"
  "3176c8eec715cccf5991efe99e1507d063f111060d97e91a74cf37ef1c111441|Player_dyn1_rr1_038.wav|Keys/Upright Piano/Player_dyn1_rr1_038.wav"
  "43cd5b95a890fd482c56fa1c49c87e63026e8968633272eed88a89abceb30d47|Player_dyn1_rr1_040.wav|Keys/Upright Piano/Player_dyn1_rr1_040.wav"
  "4bc64bcdbe1be494cc9c82246c2de8e7808432d18bd3d4dc0868fc9dd72de698|Player_dyn1_rr1_042.wav|Keys/Upright Piano/Player_dyn1_rr1_042.wav"
  "ab25ca49f0e9fbc0d14be7321a1d08fdd61a37f56d47c3140720d91c89cc34b1|Player_dyn1_rr1_044.wav|Keys/Upright Piano/Player_dyn1_rr1_044.wav"
  "32f3cda282b64a65c6b2b071c91d98019514e8ffe80154a915431fa03443ee93|Player_dyn2_rr1_000.wav|Keys/Upright Piano/Player_dyn2_rr1_000.wav"
  "2ba9838d073b9dec7ed19a4b2b3ba608f62a8a1c89694d7ef1f1afd47406683f|Player_dyn2_rr1_002.wav|Keys/Upright Piano/Player_dyn2_rr1_002.wav"
  "ea7f8c8e997794656422b9c19f3a96f8ba03a0282ee664b97437c13b5ed2865c|Player_dyn2_rr1_004.wav|Keys/Upright Piano/Player_dyn2_rr1_004.wav"
  "80ade36a6030d83d868b6abbd1e9ab6f85ec2494cfe25d2affffd88f453e81e0|Player_dyn2_rr1_006.wav|Keys/Upright Piano/Player_dyn2_rr1_006.wav"
  "52be11ac2a57389f2d12cbd82df9b175da7b60e423d8a1154e1d7fc3340ecd6e|Player_dyn2_rr1_008.wav|Keys/Upright Piano/Player_dyn2_rr1_008.wav"
  "324c53abf03b2b32ff74f52886806ab5d4a7a37f6eb9c746558799037d7e12da|Player_dyn2_rr1_010.wav|Keys/Upright Piano/Player_dyn2_rr1_010.wav"
  "9accd92b779985736589d7bf25b93f1d6d508830d2f2aad3e76a481549cc1ca2|Player_dyn2_rr1_012.wav|Keys/Upright Piano/Player_dyn2_rr1_012.wav"
  "0bdf66b89c2cd8042118b2cf9898aab334820fff7538b8553655a3d11d2ba107|Player_dyn2_rr1_014.wav|Keys/Upright Piano/Player_dyn2_rr1_014.wav"
  "87b90b8161b5ddac5f1e81cce7895c726aff220e735586059c7ed684a5ae82dc|Player_dyn2_rr1_016.wav|Keys/Upright Piano/Player_dyn2_rr1_016.wav"
  "fb39ae501f7dde4aa3626d2e382b3709962cbe5d48b6c001ba7c911d1ffb6aeb|Player_dyn2_rr1_018.wav|Keys/Upright Piano/Player_dyn2_rr1_018.wav"
  "dc314226819e7af0768cd7fc08933f5e5b550083145e05af630fd7556f4d3913|Player_dyn2_rr1_020.wav|Keys/Upright Piano/Player_dyn2_rr1_020.wav"
  "9a4e03fa389b7e59ea6b3a6719eef52be8d607844283c7163662030f57b60942|Player_dyn2_rr1_022.wav|Keys/Upright Piano/Player_dyn2_rr1_022.wav"
  "a00ae1a2b2a78c154b067a9709afc1ce2d3be9f08d9f4ad3c9c869a7db80eb75|Player_dyn2_rr1_024.wav|Keys/Upright Piano/Player_dyn2_rr1_024.wav"
  "4e668e75c3922c79ef06bd46806224dbf8dbfa0be1569847a1cd17e573a967ec|Player_dyn2_rr1_026.wav|Keys/Upright Piano/Player_dyn2_rr1_026.wav"
  "84fe87bd24dc93d354213f730517a29f485c40715d5959af97976b364110b70a|Player_dyn2_rr1_028.wav|Keys/Upright Piano/Player_dyn2_rr1_028.wav"
  "4b558995c108f7f1dcede12c7e0444caa2658205fea34a314abf485dc6b7e710|Player_dyn2_rr1_030.wav|Keys/Upright Piano/Player_dyn2_rr1_030.wav"
  "8a4b127b8420c276d8935495d13b4e493c3eaa8f8aaef75bbc4f74d6437160f2|Player_dyn2_rr1_032.wav|Keys/Upright Piano/Player_dyn2_rr1_032.wav"
  "c5305eb820902b66b0a55768733956ff21d98692810d6e2cec24d68879ef5fcd|Player_dyn2_rr1_034.wav|Keys/Upright Piano/Player_dyn2_rr1_034.wav"
  "87ef3cb2e7f234b56ca70ff323e2714bccd80d771fc6ac02dfef3405c217085c|Player_dyn2_rr1_036.wav|Keys/Upright Piano/Player_dyn2_rr1_036.wav"
  "ace4ec29aa6ae232566174c6b74ae861ce24e38e2cb3ab1d1ea5cf8e145ebdbd|Player_dyn2_rr1_038.wav|Keys/Upright Piano/Player_dyn2_rr1_038.wav"
  "25028a985a79b059659b785ecb29388bb8c173cf3a1b2e185fb8c64491d0f476|Player_dyn2_rr1_040.wav|Keys/Upright Piano/Player_dyn2_rr1_040.wav"
  "11dce969f3f159c10fbcdf4a743e4f18937b59e5e259fc24d197965fc241514d|Player_dyn2_rr1_042.wav|Keys/Upright Piano/Player_dyn2_rr1_042.wav"
  "8dbeca4e4254bd3635fdb7be54bbe57cddd751a3d0a0bda64e85baf02a4de999|Player_dyn2_rr1_044.wav|Keys/Upright Piano/Player_dyn2_rr1_044.wav"
  "529ef60490fcb922cf3d469c420608a2205042b9b329db04abc0147aa5f4ea63|Player_dyn3_rr1_000.wav|Keys/Upright Piano/Player_dyn3_rr1_000.wav"
  "3937efc793df279be101d0964cb46e3b2480f855ddb95d55f7e250eaaf725fac|Player_dyn3_rr1_002.wav|Keys/Upright Piano/Player_dyn3_rr1_002.wav"
  "f2eae20cd065108f5ea9ba3b6c3fcaeada1f0a3b12566e1a5a719389233ce6ec|Player_dyn3_rr1_004.wav|Keys/Upright Piano/Player_dyn3_rr1_004.wav"
  "565fb26f15632002fb75c0cd42defcab8fa4cb23a504655d287b4a5b8642b7a0|Player_dyn3_rr1_006.wav|Keys/Upright Piano/Player_dyn3_rr1_006.wav"
  "19080adc5446961073aaeca7d5f5594cdd7c409ee0ffb95231400dfd8c2fd947|Player_dyn3_rr1_008.wav|Keys/Upright Piano/Player_dyn3_rr1_008.wav"
  "e5fe5e4ec9c4d4818a9ce651b284eee61d25deb228c7d9d3b46b1f90f894403b|Player_dyn3_rr1_010.wav|Keys/Upright Piano/Player_dyn3_rr1_010.wav"
  "ac6644ffc1aa25d194f024d3abdae4f06d6dff1ae42ba2a7e8edc1fddcdff12b|Player_dyn3_rr1_012.wav|Keys/Upright Piano/Player_dyn3_rr1_012.wav"
  "d1d7318686f6a5ae0e78560c171bb8f9cb4bffa3d2115f6e1ed32b5d4d07f81b|Player_dyn3_rr1_014.wav|Keys/Upright Piano/Player_dyn3_rr1_014.wav"
  "bbf92571a777aeadee8751bba780b8a9a0b5913980c252d805acde2069bedb89|Player_dyn3_rr1_016.wav|Keys/Upright Piano/Player_dyn3_rr1_016.wav"
  "0914913456c74ec906e7cfed81a4b2986658c8a006e2f278dfa49784215b1a4b|Player_dyn3_rr1_018.wav|Keys/Upright Piano/Player_dyn3_rr1_018.wav"
  "515e6d85e51050867174eb901dd2fdc8018e7be0e8f320d23cdeb854531ea4c8|Player_dyn3_rr1_020.wav|Keys/Upright Piano/Player_dyn3_rr1_020.wav"
  "c2c1f3d7f6ffa05d2a840094a3191537445436bc1ef6efe01af7f0876a39d06e|Player_dyn3_rr1_022.wav|Keys/Upright Piano/Player_dyn3_rr1_022.wav"
  "cc8b22d1779248f6edc88fa5d072b8ce8b51b06fbe62be3d3d19a324d1da9030|Player_dyn3_rr1_024.wav|Keys/Upright Piano/Player_dyn3_rr1_024.wav"
  "d89966bb53c4bdabdfe453c15d9779cf1eebae10069aaa7f78bd8074bad98b1a|Player_dyn3_rr1_026.wav|Keys/Upright Piano/Player_dyn3_rr1_026.wav"
  "bf6c7d1bbf94b66e4167ecafef413835eee568f6f750dae30c2f3b9250fd89f5|Player_dyn3_rr1_028.wav|Keys/Upright Piano/Player_dyn3_rr1_028.wav"
  "d19dfdb6db0ade3b2cb7a5f6d152adc8824c86c79b4b9da0a82ac0c8bb58c02e|Player_dyn3_rr1_030.wav|Keys/Upright Piano/Player_dyn3_rr1_030.wav"
  "403a1f1a4b9df06be59fb45382af40728755c92a225d9e7c3455159ed3ae3ba7|Player_dyn3_rr1_032.wav|Keys/Upright Piano/Player_dyn3_rr1_032.wav"
  "5263ea569e710d4cddb1da780b7806cd8dcbc4d3dee6f145f900fbba0fc972b1|Player_dyn3_rr1_034.wav|Keys/Upright Piano/Player_dyn3_rr1_034.wav"
  "06f39cb4f41cb2cb46f126b60b302269307cc397ead376c9186f182c4260cd78|Player_dyn3_rr1_036.wav|Keys/Upright Piano/Player_dyn3_rr1_036.wav"
  "8b8a0f6d9789467736bc582c65ad0402798ec9c43d009e41985de4f5faa8e72c|Player_dyn3_rr1_038.wav|Keys/Upright Piano/Player_dyn3_rr1_038.wav"
  "df8692ef3371510f8492d45af6ddf9c576d5cfd88aac817c86f36afcb40866e2|Player_dyn3_rr1_040.wav|Keys/Upright Piano/Player_dyn3_rr1_040.wav"
  "9690e7ef1935f22787898a3766fc9cd96f83e18dcee9dae1e8338674386dc190|Player_dyn3_rr1_042.wav|Keys/Upright Piano/Player_dyn3_rr1_042.wav"
  "5625c4930fa958ff18e92106002e6b63ef73a1a37f99c57cf7b7900abaf8ccd3|Player_dyn3_rr1_044.wav|Keys/Upright Piano/Player_dyn3_rr1_044.wav"
)

fetched=0
for entry in "${PINS[@]}"; do
  IFS='|' read -r sha name src <<<"$entry"
  f="$DEST/$name"
  if [ -f "$f" ] && [ "$(sha256sum "$f" | awk '{print $1}')" = "$sha" ]; then
    continue
  fi
  curl -fsSL --retry 3 -o "$f.part" "$BASE/${src// /%20}"
  actual=$(sha256sum "$f.part" | awk '{print $1}')
  if [ "$actual" != "$sha" ]; then
    echo "ERROR: SHA-256 mismatch for $name"
    echo "  Expected: $sha"
    echo "  Actual:   $actual"
    rm -f "$f.part"
    exit 1
  fi
  mv "$f.part" "$f"
  fetched=$((fetched + 1))
done

if ! grep -q "CC0 1.0 Universal" "$DEST/LICENSE"; then
  echo "ERROR: pianokits/vsco_upright/LICENSE is not the CC0 1.0 Universal text; check by hand"
  exit 1
fi
echo "✓ ${#PINS[@]} files verified (SHA-256), $fetched downloaded, license CC0 1.0 Universal"
echo "Done: held-out piano samples ready in $DEST/ ($(du -sh "$DEST" | awk '{print $1}'))"
