(function () {
  const CONFIG = window.SITE_CONFIG || {};
  const style = CONFIG.brandStyle || {};

  const brandMain = document.getElementById("brand-main");
  const brandSub = document.getElementById("brand-sub");
  const footerBrand = document.getElementById("footer-brand");
  const faviconLink = document.getElementById("favicon-link");

  if (brandMain) {
    brandMain.textContent = CONFIG.brandMain || "BARE";
    brandMain.style.letterSpacing = style.mainLetterSpacing || ".26em";
    brandMain.style.fontSize = style.mainFontSize || "24px";
    brandMain.style.fontWeight = style.mainWeight || "600";
  }

  if (brandSub) {
    brandSub.textContent = CONFIG.brandSub || "by Marlese";
    brandSub.style.letterSpacing = style.subLetterSpacing || ".05em";
    brandSub.style.fontSize = style.subFontSize || "15px";
    brandSub.style.fontWeight = style.subWeight || "500";
  }

  if (footerBrand) {
    footerBrand.textContent = CONFIG.businessName || "BARE by Marlese";
  }

  if (faviconLink) {
    faviconLink.href = CONFIG.favicon || "/faviconv4.png";
  }
})();
