import { memo } from 'react'

/**
 * サイトの説明（日本語・英語）。検索から来た方・初めての方が、何ができるかを読んで分かるようにする。
 * 実際にある機能だけを書き、未検証の音響性能（「本物の 3D」など）や検索順位に関わる表現は書かない
 */
export const AboutSection = memo(function AboutSection() {
  return (
    <section className="about" aria-label="CINEMA SONIC X について / About" data-ui="about">
      <div lang="ja">
        <h2>CINEMA SONIC X でできること</h2>
        <p>音声・動画ファイルの音を、ブラウザの中だけで立体音響と重低音に加工する Web アプリです。ファイルはサーバーへ送信しません。</p>
        <ul>
          <li>4 種類のプリセット（CINEMA 3D / LIVE ARENA / 360° MOTION / IMMERSIVE X）と、STUDIO MODE の詳細設定</li>
          <li>元の音（ORIGINAL）と加工した音（PROCESSED）を再生中に切り替えて聴き比べ</li>
          <li>WAV（16 / 24-bit）の書き出し。動画は映像を再エンコードせずに音声だけを差し替え</li>
          <li>ファイルがなくても「サンプル音源で試す」で公式デモ音源（40 秒）を試せます</li>
        </ul>
        <p>PC の Chrome / Edge を推奨します。ヘッドホン向けのプリセットの方向感には個人差があります。</p>
      </div>
      <div lang="en">
        <h2>About CINEMA SONIC X</h2>
        <p>A web app that applies spatial audio and bass processing to audio and video files entirely inside your browser. Your files are not uploaded to any server.</p>
        <ul>
          <li>Four presets (CINEMA 3D, LIVE ARENA, 360° MOTION, IMMERSIVE X) plus detailed controls in STUDIO MODE</li>
          <li>Switch between ORIGINAL and PROCESSED during playback to compare</li>
          <li>Export WAV (16/24-bit); for video, only the audio track is replaced and the video stream is copied without re-encoding</li>
          <li>No file at hand? Try the official 40-second demo track with “サンプル音源で試す” (Try the sample)</li>
        </ul>
        <p>Desktop Chrome or Edge is recommended. Perceived direction with the headphone presets varies from person to person.</p>
      </div>
    </section>
  )
})
