const { CHINA_EDITION, getReleaseChannel } = require('./scripts/release/edition')

module.exports = async function createChinaEditionConfig({ packageMetadata }) {
  const { version } = await packageMetadata.value

  return {
    extends: './electron-builder.yml',
    appId: 'com.bimhu.chat.cn',
    extraMetadata: {
      cherryEdition: CHINA_EDITION
    },
    publish: {
      provider: 'generic',
      url: 'https://releases.cherry-ai.com',
      channel: getReleaseChannel(version, CHINA_EDITION)
    }
  }
}
